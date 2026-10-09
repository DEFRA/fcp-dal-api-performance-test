// Gets a Defra ID user token from the FCP Defra ID stub (https://github.com/DEFRA/fcp-defra-id-stub)
// by driving its sign-in journey headlessly: authorize -> CRN/password -> organisation -> code -> token.
//
// The stub only checks that client id, client secret, service id and password are present, so any
// values work. In its default (Basic) mode any 10 digit CRN is accepted and every CRN has the same
// three mock organisations (5900001, 5900002, 5900003).
//
// Prints only the access token to stdout; everything else goes to stderr.

const axios = require('axios')
const { setTimeout: sleep } = require('node:timers/promises')
const { v4: uuid } = require('uuid')

const config = {
  wellKnownUrl: process.env.DEFRA_ID_WELL_KNOWN_URL,
  crn: process.env.DEFRA_ID_CRN,
  password: process.env.DEFRA_ID_PASSWORD,
  clientId: process.env.DEFRA_ID_CLIENT_ID,
  clientSecret: process.env.DEFRA_ID_CLIENT_SECRET,
  serviceId: process.env.DEFRA_ID_SERVICE_ID,
  redirectUrl: process.env.DEFRA_ID_REDIRECT_URL,
  relationshipId: process.env.DEFRA_ID_RELATIONSHIP_ID // optional, needed if the CRN has several organisations
}
const missing = Object.entries(config)
  .filter(([key, value]) => !value && key !== 'relationshipId')
  .map(([key]) => key)
if (missing.length) {
  throw new Error(`Missing Defra ID stub config: ${missing.join(', ')}`)
}

// ---- minimal HTTP client: single cookie jar (the stub keeps the auth request in a session cookie) ----

const cookies = {}
const storeCookies = (headers) => {
  for (const line of headers['set-cookie'] || []) {
    const pair = line.split(';')[0]
    const i = pair.indexOf('=')
    if (i > 0) cookies[pair.slice(0, i).trim()] = pair.slice(i + 1).trim()
  }
}
const cookieHeader = () =>
  Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ')

// CDP hosts occasionally drop connections; a short pause and retry recovers these
const request = async (method, url, { body, headers = {} } = {}, retriesLeft = 3) => {
  try {
    const cookie = cookieHeader()
    const response = await axios({
      method,
      url,
      data: body,
      maxRedirects: 0,
      validateStatus: () => true,
      transformResponse: [(data) => data],
      headers: { ...(cookie ? { cookie } : {}), ...headers }
    })
    storeCookies(response.headers)
    return response
  } catch (cause) {
    if (retriesLeft <= 0) throw new Error(`${method} ${url} failed: ${cause.message}`)
    await sleep(2000)
    return request(method, url, { body, headers }, retriesLeft - 1)
  }
}

const form = (fields) => ({
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields).toString()
})

// follows redirects while they stay on the stub; returns the redirect that leaves it (back to the
// app with the code), or the stub page the journey stopped on
const followStub = async (method, url, options, hopsLeft = 10) => {
  if (hopsLeft <= 0) throw new Error('Too many redirects')
  const response = await request(method, url, options)
  const location = response.headers.location
  if (response.status < 300 || response.status >= 400 || !location) return { page: response, url }
  const next = new URL(location, url)
  if (next.origin !== new URL(url).origin) return { redirect: next }
  return followStub('GET', next.href, undefined, hopsLeft - 1)
}

// ---- page helpers ----

/**
 * Reads the GOV.UK error message shown on a stub page, if there is one.
 *
 * @param {string} html - the page HTML
 * @returns {string | undefined} the error text without its "Error:" prefix, or undefined if the
 *   page shows none
 */
const errorMessage = (html) =>
  /govuk-error-message">\s*<span[^>]*>Error:<\/span>([^<]+)/.exec(html)?.[1]?.trim()

/**
 * Lists the organisations offered on the stub's organisation picker page.
 *
 * @param {string} html - the picker page HTML
 * @returns {string[]} the label of each organisation option, with `&amp;` decoded (empty if none
 *   are found)
 */
const pickerOrganisations = (html) =>
  [...html.matchAll(/value="(\d+)"[^>]*>\s*<label[^>]*>([^<]+)</g)].map((m) => m[2].trim().replaceAll('&amp;', '&'))

/**
 * Explains why the sign-in journey stopped on a stub page instead of redirecting back to the app,
 * for use as an error message.
 *
 * @param {import('axios').AxiosResponse} page - the response for the page the journey stopped on
 * @returns {string} a message for the organisation picker (listing the organisations to choose
 *   from), a rejected sign in, or any other page (with its status and error or opening HTML)
 */
const describeStoppedPage = (page) => {
  const html = String(page.data)
  if (/name="sbi"/.test(html)) {
    return (
      'The stub is asking which business to use - set DEFRA_ID_RELATIONSHIP_ID to one of the ' +
      `organisation ids for this CRN. Offered: ${pickerOrganisations(html).join('; ') || 'unknown'}`
    )
  }
  if (/name="crn"/.test(html)) return `Sign in rejected: ${errorMessage(html) || 'unknown reason'}`
  return `Journey stopped on an unexpected page (HTTP ${page.status}): ${errorMessage(html) || html.slice(0, 200)}`
}

// ---- the journey ----

/**
 * Fetches the stub's OIDC discovery document from the configured well-known URL.
 *
 * @returns {Promise<{ authorization_endpoint: string, token_endpoint: string }>} the discovery
 *   document (other fields omitted)
 * @throws {Error} if the response isn't JSON or has no `authorization_endpoint`
 */
const getDiscovery = async () => {
  const res = await request('GET', config.wellKnownUrl, { headers: { accept: 'application/json' } })
  const oidc = JSON.parse(res.data)
  if (!oidc.authorization_endpoint) throw new Error('Discovery document has no authorization_endpoint')
  return oidc
}

/**
 * Drives the stub's sign-in journey (authorize -> CRN/password -> organisation) using the
 * configured CRN, password and optional relationship id.
 *
 * @param {{ authorization_endpoint: string }} oidc - OIDC discovery document from the stub
 * @param {string} state - value to send as the OAuth `state`, echoed back on the redirect
 * @returns {Promise<URL>} the redirect back to `redirect_uri`, carrying the auth code and state
 * @throws {Error} if the journey leaves the stub too early or stops on a stub page (e.g. sign in
 *   rejected, or an organisation must be chosen because DEFRA_ID_RELATIONSHIP_ID is not set)
 */
const signIn = async (oidc, state) => {
  const authorizeUrl =
    oidc.authorization_endpoint +
    '?' +
    new URLSearchParams({
      client_id: config.clientId,
      serviceId: config.serviceId,
      response_type: 'code',
      response_mode: 'query',
      redirect_uri: config.redirectUrl,
      scope: `openid offline_access ${config.clientId}`,
      state,
      nonce: uuid(),
      ...(config.relationshipId ? { relationshipId: config.relationshipId } : {})
    })

  // authorize stores the request in the session cookie and redirects to the sign-in page, which a
  // browser would then show; skip straight to submitting it
  const authorize = await followStub('GET', authorizeUrl)
  if (authorize.redirect) throw new Error(`authorize redirected away from the stub: ${authorize.redirect}`)
  if (!/name="crn"/.test(String(authorize.page.data))) throw new Error(describeStoppedPage(authorize.page))

  // sign in -> /organisations -> back to redirect_uri with the code (organisation picked by
  // relationshipId, or automatically when the CRN has only one)
  const result = await followStub('POST', authorize.url, form({ crn: config.crn, password: config.password }))
  if (!result.redirect) throw new Error(describeStoppedPage(result.page))
  return result.redirect
}

/**
 * Pulls the auth code out of the redirect the stub sends back to the app, after checking it went
 * to the configured redirect URL's host and carries the expected state.
 *
 * @param {URL} location - the redirect returned by signIn
 * @param {string} state - the OAuth `state` sent with the authorize request
 * @returns {string} the auth code
 * @throws {Error} if the redirect is to an unexpected host, has no code, or the state doesn't match
 */
const extractAuthCode = (location, state) => {
  if (location.origin !== new URL(config.redirectUrl).origin) {
    throw new Error(`Stub redirected to an unexpected host: ${location.origin}`)
  }
  const code = location.searchParams.get('code')
  if (!code) throw new Error(`Redirected back without a code: ${location.href}`)
  if (location.searchParams.get('state') !== state) throw new Error('State mismatch on redirect')
  return code
}

/**
 * Exchanges an auth code for an access token at the stub's token endpoint, using the configured
 * client id, client secret and redirect URL.
 *
 * @param {{ token_endpoint: string }} oidc - OIDC discovery document from the stub
 * @param {string} code - auth code from the sign-in redirect
 * @returns {Promise<string>} the access token (a JWT)
 * @throws {Error} if the token endpoint doesn't return HTTP 200 with an `access_token`, including
 *   when the response isn't JSON
 */
const exchangeCodeForToken = async (oidc, code) => {
  const res = await request(
    'POST',
    oidc.token_endpoint,
    form({
      grant_type: 'authorization_code',
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUrl
    })
  )
  let token = {}
  let notJson = ''
  try {
    token = JSON.parse(res.data)
  } catch (error_) {
    notJson = ` (response is not JSON: ${error_.message})`
  }
  if (res.status !== 200 || !token.access_token) {
    throw new Error(
      `Token endpoint failed: HTTP ${res.status} ${token.message || String(res.data).slice(0, 200)}${notJson}`
    )
  }
  return token.access_token
}

;(async () => {
  const oidc = await getDiscovery()
  const state = uuid()
  const location = await signIn(oidc, state)
  const accessToken = await exchangeCodeForToken(oidc, extractAuthCode(location, state))

  const claims = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString())
  console.error(
    `Defra ID stub token for CRN ${claims.contactId}, organisation ${claims.currentRelationshipId}, ` +
      `expires ${new Date(claims.exp * 1000).toISOString()}`
  )

  // only the token goes to stdout so the calling script can capture it
  console.log(accessToken)
})().catch((error) => {
  console.error(`ERROR getting Defra ID token: ${error.message}`)
  process.exit(1)
})
