// Gets a Defra ID user token by driving a sign-in journey headlessly: authorize -> sign in -> code
// -> token. DEFRA_ID_PROVIDER picks the journey:
//   stub - the FCP Defra ID stub (see signin-stub.js)
//   b2c  - the real Defra ID, on Azure AD B2C (see signin-b2c.js)
//
// Prints only the access token to stdout; everything else goes to stderr.

const { v4: uuid } = require('uuid')
const { request, form } = require('./http')

const providers = {
  stub: require('./signin-stub'),
  b2c: require('./signin-b2c')
}

const config = {
  provider: process.env.DEFRA_ID_PROVIDER,
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
  throw new Error(`Missing Defra ID config: ${missing.join(', ')}`)
}
if (!providers[config.provider]) {
  throw new Error(`Unknown DEFRA_ID_PROVIDER '${config.provider}' - use one of: ${Object.keys(providers).join(', ')}`)
}

/**
 * Fetches the OIDC discovery document from the configured well-known URL.
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

// asking for the client id as a scope is what gets an access token, not just an id token
const scope = () => `openid offline_access ${config.clientId}`

/**
 * Builds the authorize request URL from the configured client and service (each provider's signIn
 * adds anything specific to it).
 *
 * @param {{ authorization_endpoint: string }} oidc - OIDC discovery document
 * @param {string} state - value to send as the OAuth `state`, echoed back on the redirect
 * @returns {string} the authorize URL
 */
const authorizeUrl = (oidc, state) =>
  oidc.authorization_endpoint +
  '?' +
  new URLSearchParams({
    client_id: config.clientId,
    serviceId: config.serviceId,
    response_type: 'code',
    response_mode: 'query',
    redirect_uri: config.redirectUrl,
    scope: scope(),
    state,
    nonce: uuid()
  })

/**
 * Pulls the auth code out of the redirect sent back to the app, after checking it went to the
 * configured redirect URL's host and carries the expected state.
 *
 * @param {URL} location - the redirect returned by the provider's signIn
 * @param {string} state - the OAuth `state` sent with the authorize request
 * @returns {string} the auth code
 * @throws {Error} if the redirect is to an unexpected host, carries an error or no code, or the
 *   state doesn't match
 */
const extractAuthCode = (location, state) => {
  if (location.origin !== new URL(config.redirectUrl).origin) {
    throw new Error(`Redirected to an unexpected host: ${location.origin}`)
  }
  const error = location.searchParams.get('error')
  if (error) throw new Error(`Redirected back with error: ${error} - ${location.searchParams.get('error_description') || ''}`)
  const code = location.searchParams.get('code')
  if (!code) throw new Error(`Redirected back without a code: ${location.href}`)
  if (location.searchParams.get('state') !== state) throw new Error('State mismatch on redirect')
  return code
}

/**
 * Exchanges an auth code for an access token at the token endpoint, using the configured client
 * id, client secret and redirect URL.
 *
 * @param {{ token_endpoint: string }} oidc - OIDC discovery document
 * @param {string} code - auth code from the sign-in redirect
 * @returns {Promise<string>} the access token (a JWT)
 * @throws {Error} if the token endpoint doesn't return HTTP 200 with an `access_token`, including
 *   when the response isn't JSON
 */
const exchangeCodeForToken = async (oidc, code) => {
  const res = await request(
    'POST',
    oidc.token_endpoint,
    form(
      {
        grant_type: 'authorization_code',
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUrl,
        scope: scope()
      },
      { accept: 'application/json' }
    )
  )
  let token = {}
  let notJson = ''
  try {
    token = JSON.parse(res.data)
  } catch (error_) {
    notJson = ` (response is not JSON: ${error_.message})`
  }
  if (res.status !== 200 || !token.access_token) {
    // the stub reports errors in message, B2C in error_description
    const reason = token.message || token.error_description || String(res.data).slice(0, 200)
    throw new Error(`Token endpoint failed: HTTP ${res.status} ${reason}${notJson}`)
  }
  return token.access_token
}

;(async () => {
  const oidc = await getDiscovery()
  const state = uuid()
  const location = await providers[config.provider].signIn(authorizeUrl(oidc, state), config)
  const accessToken = await exchangeCodeForToken(oidc, extractAuthCode(location, state))

  const claims = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString())
  console.error(
    `Defra ID (${config.provider}) token for CRN ${claims.contactId}, organisation ${claims.currentRelationshipId}, ` +
      `expires ${new Date(claims.exp * 1000).toISOString()}`
  )

  // only the token goes to stdout so the calling script can capture it
  console.log(accessToken)
})().catch((error) => {
  console.error(`ERROR getting Defra ID token: ${error.message}`)
  process.exit(1)
})
