const axios = require('axios')
const { v4: uuid } = require('uuid')

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const MAX_ROUNDS = 8

// ---- config (defraId* env vars; password/client secret come from the collection .env) ----

//const interpolate = (value) => {
//  const m = /^\{\{process\.env\.(\w+)\}\}$/.exec(value || '')
//  return m ? bru.getProcessEnv(m[1]) : value
//}

const config = {
  crn: process.argv[2], // bru.getEnvVar('defraIdCrn'),  ** Not secret **
  policy: process.argv[7], //bru.getEnvVar('defraIdPolicy'), ** Not secret **
  redirectUrl: process.argv[8], //bru.getEnvVar('defraIdRedirectUrl'), ** Not secret **
  relationshipId: process.argv[9], //bru.getEnvVar('defraIdRelationshipId') ** Not secret **
  password: process.argv[3], // interpolate(bru.getEnvVar('defraIdPassword')), ** Is secret **
  clientId: process.argv[4], //bru.getEnvVar('defraIdClientId'), ** Is secret **
  clientSecret: process.argv[5], //interpolate(bru.getEnvVar('defraIdClientSecret')), ** Is secret **
  serviceId: process.argv[6], //bru.getEnvVar('defraIdServiceId'), ** Is secret **
}
const missing = Object.entries(config)
  .filter(([key, value]) => !value && key !== 'relationshipId')
  .map(([key]) => key)
if (missing.length) {
  throw new Error(
    `Missing Defra ID config: ${missing.join(', ')} ` +
      '(defraId* env vars; password/client secret come from the collection .env)'
  )
}
config.scope = `openid offline_access ${config.clientId}`

// ---- minimal HTTP client: per-host cookie jar, manual redirects, retries ----

const jars = {}
const storeCookies = (host, headers) => {
  for (const line of headers['set-cookie'] || []) {
    const pair = line.split(';')[0]
    const i = pair.indexOf('=')
    if (i > 0) (jars[host] = jars[host] || {})[pair.slice(0, i).trim()] = pair.slice(i + 1).trim()
  }
}
const cookieHeader = (host) =>
  Object.entries(jars[host] || {})
    .map(([name, value]) => `${name}=${value}`)
    .join('; ')

const request = async (method, url, { body, headers = {}, followRedirects = true, stopAtOrigin } = {}) => {
  // the Defra ID hosts intermittently drop connections (timeouts, TLS resets); a
  // short pause and retry recovers these without restarting the whole journey
  let retries = 3
  for (let hop = 0; hop < 25; hop++) {
    const host = new URL(url).host
    const cookie = cookieHeader(host)
    let response
    try {
      response = await axios({
        method,
        url,
        data: body,
        maxRedirects: 0,
        validateStatus: () => true,
        transformResponse: [(data) => data],
        headers: {
          'user-agent': UA,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          ...(cookie ? { cookie } : {}),
          ...headers
        }
      })
    } catch (cause) {
      if (retries-- > 0) {
        await new Promise((resolve) => setTimeout(resolve, 2000))
        hop--
        continue
      }
      throw new Error(`${method} ${url} failed: ${cause.message}`)
    }
    storeCookies(host, response.headers)
    response.finalUrl = url
    const location = response.headers.location
    if (!followRedirects || !location || response.status < 300 || response.status >= 400) {
      return response
    }
    const next = new URL(location, url)
    if (stopAtOrigin && next.origin === stopAtOrigin) return response
    url = next.href
    if (response.status !== 307 && response.status !== 308) {
      method = 'GET'
      body = undefined
      headers = {}
    }
  }
  throw new Error('Too many redirects')
}

// ---- page scraping helpers ----

const parseSettings = (html) => {
  const marker = 'var SETTINGS = '
  const start = html.indexOf(marker + '{')
  if (start === -1) return null
  const from = start + marker.length
  // the SETTINGS object contains nested braces, so grow the slice one `}` at a
  // time until it parses
  for (let end = html.indexOf('}', from); end !== -1; end = html.indexOf('}', end + 1)) {
    try {
      const s = JSON.parse(html.slice(from, end + 1))
      return { csrf: s.csrf, transId: s.transId, api: s.api, tenant: s.hosts?.tenant, policy: s.hosts?.policy }
    } catch (ignored) {}
  }
  return null
}
const parseFieldIds = (html) =>
  [...html.matchAll(/"ID"\s*:\s*"([^"]*)"/g)].map((m) => m[1]).filter(Boolean)
const inputValue = (html, name) =>
  html.match(new RegExp(`<input[^>]*name="${name}"[^>]*value="([^"]*)"`))?.[1] ??
  html.match(new RegExp(`<input[^>]*value="([^"]*)"[^>]*name="${name}"`))?.[1]
const tryJson = (body) => {
  try {
    return JSON.parse(body)
  } catch (ignored) {
    return {}
  }
}

// ---- journey steps ----

const readDiscovery = (res) => {
  const rawBody = res.data
  const oidc = typeof rawBody === 'string' ? tryJson(rawBody) : rawBody
  if (!oidc.authorization_endpoint) throw new Error('Discovery document has no authorization_endpoint')
  return oidc
}

// Front door: idphub check-js gate, then relay the auto-POST callback to B2C;
// returns the first B2C SelfAsserted page
const passFrontDoor = async () => {
  const authorizeUrl =
    oidc.authorization_endpoint +
    '?' +
    new URLSearchParams({
      client_id: config.clientId,
      response_type: 'code',
      redirect_uri: config.redirectUrl,
      scope: config.scope,
      response_mode: 'query',
      state,
      nonce: uuid(),
      serviceId: config.serviceId,
      p: config.policy
    })
  const gatePage = await request('GET', authorizeUrl)
  const crumb = inputValue(gatePage.data, 'crumb')
  if (!crumb) throw new Error('Did not reach the idphub check-js page (unexpected journey).')

  const checkJsUrl = new URL('/registration/journey/check-js/check-js-enabled', gatePage.finalUrl).href
  const resumePage = await request('POST', checkJsUrl, {
    headers: { 'content-type': 'application/x-www-form-urlencoded', referer: checkJsUrl },
    body: new URLSearchParams({ crumb, checkJs: '' }).toString()
  })
  const callbackAction = resumePage.data
    .match(/<form[^>]*action="([^"]*authresp[^"]*)"/)?.[1]
    ?.replace(/&amp;/g, '&')
  const cbCode = inputValue(resumePage.data, 'code')
  const cbState = inputValue(resumePage.data, 'state')
  if (!callbackAction || !cbCode) throw new Error('idphub did not return a callback code (check-js gate failed).')

  return request('POST', callbackAction, {
    headers: { 'content-type': 'application/x-www-form-urlencoded', referer: `${b2cBase}/` },
    body: new URLSearchParams({ code: cbCode, state: cbState }).toString()
  })
}

// what to submit for the current page: crn+password, business picker, or an
// empty pre-step
const stepBody = (fields) => {
  const body = new URLSearchParams({ request_type: 'RESPONSE' })
  if (fields.includes('crn')) {
    body.set('crn', config.crn)
    body.set('password', config.password)
  } else if (fields.includes('currentRelationshipId')) {
    if (!config.relationshipId) {
      throw new Error('This account has multiple businesses - set defraIdRelationshipId.')
    }
    body.set('currentRelationshipId', config.relationshipId)
  } else {
    for (const field of fields) body.set(field, '')
  }
  return body
}

const submitStep = async (settings, body) => {
  const saRes = await request(
    'POST',
    `${b2cBase}${settings.tenant}/SelfAsserted?tx=${encodeURIComponent(settings.transId)}&p=${settings.policy}`,
    {
      followRedirects: false,
      headers: {
        'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'x-csrf-token': settings.csrf,
        'x-requested-with': 'XMLHttpRequest',
        referer: `${b2cBase}${settings.tenant}/`
      },
      body: body.toString()
    }
  )
  const saJson = tryJson(saRes.data)
  if (saRes.status !== 200 || (saJson.status && String(saJson.status) !== '200')) {
    throw new Error(
      `B2C rejected the step (HTTP ${saRes.status}, status ${saJson.status || 'none'}): ` +
        (saJson.message || String(saRes.data).slice(0, 200))
    )
  }
}

const confirmStep = (settings) =>
  request(
    'GET',
    `${b2cBase}${settings.tenant}/api/${settings.api}/confirmed?rememberMe=false&csrf_token=${settings.csrf}&tx=${encodeURIComponent(settings.transId)}&p=${settings.policy}`,
    { stopAtOrigin: redirectOrigin }
  )

const extractAuthCode = (location) => {
  const error = location.searchParams.get('error')
  if (error) {
    throw new Error(
      `Defra Identity returned error: ${error} - ${location.searchParams.get('error_description') || ''}`
    )
  }
  const code = location.searchParams.get('code')
  if (!code) throw new Error('Redirected back with neither a code nor an error (unexpected journey).')
  const returnedState = location.searchParams.get('state')
  if (returnedState && returnedState !== state) throw new Error('State mismatch on redirect (possible CSRF).')
  return code
}

// B2C SelfAsserted rounds: pre-step, crn+password, business picker (if shown);
// returns the authorization code once B2C redirects back to the app
const runB2CRounds = async (firstPage) => {
  let page = firstPage
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const settings = parseSettings(page.data)
    if (!settings || !settings.csrf || !settings.transId) {
      throw new Error(
        `Expected a B2C SelfAsserted page but found none (round ${round}).` +
          (/error/i.test(page.data) ? ' The page mentions an error - check credentials.' : '')
      )
    }
    await submitStep(settings, stepBody(parseFieldIds(page.data)))
    const confirmed = await confirmStep(settings)
    const location = confirmed.headers.location && new URL(confirmed.headers.location, b2cBase)
    if (location && location.origin === redirectOrigin) return extractAuthCode(location)
    page = confirmed
  }
  throw new Error(`Completed ${MAX_ROUNDS} journey rounds without a redirect back to the app.`)
}

const exchangeCodeForToken = async (code) => {
  const tokenRes = await request('POST', oidc.token_endpoint, {
    followRedirects: false,
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.redirectUrl,
      scope: config.scope
    }).toString()
  })
  const token = tryJson(tokenRes.data)
  if (tokenRes.status !== 200 || token.error) {
    throw new Error(
      `Token endpoint failed: HTTP ${tokenRes.status} ${token.error || ''}: ` +
        `${(token.error_description || '').split('\n')[0]}`
    )
  }
  if (!token.access_token) {
    throw new Error('Token endpoint returned no access_token (is the client id missing from the requested scope?)')
  }
  return token.access_token
}

/*
// align the collection's identity env vars with the account the token belongs to;
// relationship strings are `organisationId:sbi:name:loa:role:status`
const applyTokenToEnv = (defraIdToken) => {
  bru.setEnvVar('defraIdToken', defraIdToken)
  console.log('Defra ID token stored in env var defraIdToken')
  const claims = JSON.parse(Buffer.from(defraIdToken.split('.')[1], 'base64url').toString())
  const relationship =
    claims.relationships.find((r) => r.startsWith(`${claims.currentRelationshipId}:`)) ||
    claims.relationships[0]
  const [organisationId, sbi] = relationship.split(':')
  bru.setEnvVar('crn', claims.contactId)
  bru.setEnvVar('organisationId', organisationId)
  bru.setEnvVar('sbi', sbi)
  return { claims, organisationId, sbi }
}

// personId and frn are not in the token - look them up through the gateway with the
// fresh token; failures leave the existing env vars untouched
const lookupPersonAndFrn = async (defraIdToken, claims, organisationId) => {
  const lookups = { personId: null, frn: null }
  const apiUrl = bru.getEnvVar('apiUrl')
  const apiKey = bru.getProcessEnv('X_API_KEY')
  if (!apiUrl || !apiKey) {
    console.log('apiUrl/X_API_KEY not set - skipped personId/frn lookups')
    return lookups
  }
  const gatewayGet = async (path) => {
    const response = await axios({
      method: 'GET',
      url: `${apiUrl}${path}`,
      validateStatus: () => true,
      headers: {
        authorization: defraIdToken,
        crn: claims.contactId,
        'x-api-key': apiKey,
        accept: 'application/json'
      }
    })
    if (response.status !== 200) {
      throw new Error(`HTTP ${response.status}: ${JSON.stringify(response.data).slice(0, 200)}`)
    }
    return response.data
  }
  try {
    // the external API has no person search, but the organisation's people list
    // includes each person's id alongside their CRN
    const people = await gatewayGet(`/authorisation/organisation/${organisationId}`)
    lookups.personId =
      people?._data?.find((p) => String(p.customerReference) === String(claims.contactId))?.id ?? null
    if (lookups.personId) bru.setEnvVar('personId', String(lookups.personId))
    else console.log('personId lookup: no person in the organisation matches the CRN - env var left unchanged')
  } catch (cause) {
    console.log(`personId lookup failed (${cause.message}) - env var left unchanged`)
  }
  try {
    const organisation = await gatewayGet(`/organisation/${organisationId}`)
    lookups.frn = organisation?._data?.businessReference ?? null
    if (lookups.frn) bru.setEnvVar('frn', String(lookups.frn))
    else console.log('frn lookup: organisation has no businessReference - env var left unchanged')
  } catch (cause) {
    console.log(`frn lookup failed (${cause.message}) - env var left unchanged`)
  }
  return lookups
}


// show the token and everything derived from it in the response pane instead of
// the discovery document the request itself fetched
const showSummary = (defraIdToken, claims, organisationId, sbi, lookups) => {
  const updated = ['crn', 'organisationId', 'sbi', lookups.personId && 'personId', lookups.frn && 'frn']
    .filter(Boolean)
    .join(', ')
  res.setBody({
    note: `Token stored in the defraIdToken env var (sent as the Authorization header by collection.bru); ${updated} env vars updated to match.`,
    expires: new Date(claims.exp * 1000).toISOString(),
    crn: claims.contactId,
    organisationId,
    sbi,
    personId: lookups.personId,
    frn: lookups.frn,
    relationships: claims.relationships,
    roles: claims.roles,
    defraIdToken
  })
}
*/

// ---- the journey ----

(async () => {
  const res = await axios.get("https://your-account.pre.cui.defra.gov.uk/idphub/b2c/b2c_1a_cui_signupsigninsfi/.well-known/openid-configuration")
  const oidc = readDiscovery(res)
  const b2cBase = new URL(oidc.authorization_endpoint).origin
  const redirectOrigin = new URL(config.redirectUrl).origin
  const state = uuid()

  const firstB2CPage = await passFrontDoor()
  const code = await runB2CRounds(firstB2CPage)
  const defraIdToken = await exchangeCodeForToken(code)
})();

// Output the ID so it can be picked up by the process calling this file
console.log(defraIdToken)

// const { claims, organisationId, sbi } = applyTokenToEnv(defraIdToken)
// const lookups = await lookupPersonAndFrn(defraIdToken, claims, organisationId)
// showSummary(defraIdToken, claims, organisationId, sbi, lookups)
