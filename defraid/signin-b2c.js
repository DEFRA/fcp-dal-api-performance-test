// Sign-in journey for the real Defra ID (Azure AD B2C), replaying what a browser does:
//   1. front door: authorize redirects to the idphub check-js gate; submitting it returns a form
//      that auto-posts a callback code to B2C, which answers with the first B2C page
//   2. B2C SelfAsserted rounds: each page is submitted (POST SelfAsserted, then GET confirmed) with
//      every field's pre-filled value, plus the CRN and password on the sign-in page and the chosen
//      business on the business picker, until B2C redirects back to redirect_uri with the code
//
// Needs a client registered with Defra ID (client id, secret, service id and an allowed redirect
// URL) and a test account. The idphub host is the one serving the well-known URL; B2C is the
// authorize endpoint's host.

const { request, form } = require('./http')

const MAX_ROUNDS = 8

// follows redirects across hosts, as a browser does, until one goes to the app (returned as the
// redirect) or a page is returned; 307/308 keep the method and body, anything else becomes a GET
const follow = async (method, url, options, redirectOrigin, hopsLeft = 25) => {
  if (hopsLeft <= 0) throw new Error('Too many redirects')
  const response = await request(method, url, options)
  const location = response.headers.location
  if (response.status < 300 || response.status >= 400 || !location) return { page: response, url }
  const next = new URL(location, url)
  if (next.origin === redirectOrigin) return { redirect: next }
  const keep = response.status === 307 || response.status === 308
  return follow(keep ? method : 'GET', next.href, keep ? options : undefined, redirectOrigin, hopsLeft - 1)
}

// ---- page scraping ----

/**
 * Reads one of the JSON objects B2C embeds in its pages as `var NAME = {...};`. They contain
 * nested braces, so the slice grows one `}` at a time until it parses.
 *
 * @param {string} html - the page HTML
 * @param {string} name - the variable name, e.g. SETTINGS
 * @returns {object | undefined} the parsed object, or undefined if the page has none
 */
const pageVar = (html, name) => {
  const marker = `var ${name} = `
  const start = html.indexOf(`${marker}{`)
  if (start === -1) return undefined
  const from = start + marker.length
  for (let end = html.indexOf('}', from); end !== -1; end = html.indexOf('}', end + 1)) {
    try {
      return JSON.parse(html.slice(from, end + 1))
    } catch {
      // not a complete object yet
    }
  }
  return undefined
}

// the page's fields with their pre-filled values, in page order
const pageFields = (html) =>
  (pageVar(html, 'SA_FIELDS')?.AttributeFields || [])
    .filter((field) => field.ID)
    .map((field) => ({ id: field.ID, value: String(field.PRE ?? '').trim() }))

const inputValue = (html, name) =>
  new RegExp(`<input[^>]*name="${name}"[^>]*value="([^"]*)"`).exec(html)?.[1] ??
  new RegExp(`<input[^>]*value="([^"]*)"[^>]*name="${name}"`).exec(html)?.[1]

const tryJson = (body) => {
  try {
    return JSON.parse(body)
  } catch {
    return {}
  }
}

/**
 * Explains why the journey stopped on a page it didn't expect, for use as an error message.
 *
 * @param {import('axios').AxiosResponse} page - the response for the page the journey stopped on
 * @param {string} expected - what the journey expected to find
 * @returns {string} B2C's error detail if the page is a B2C error page, otherwise the page's status
 *   and opening HTML
 */
const describeStoppedPage = (page, expected) => {
  const html = String(page.data)
  const detail = pageVar(html, 'GLOBALEX')?.Detail
  if (detail) return `Defra ID error: ${detail.replaceAll('&#39;', "'")}`
  return `Expected ${expected} but got HTTP ${page.status}: ${html.slice(0, 200)}`
}

// ---- journey steps ----

/**
 * Passes the idphub check-js gate and relays its auto-posted callback to B2C.
 *
 * @returns {Promise<{ page?: import('axios').AxiosResponse, redirect?: URL }>} the first B2C page,
 *   or a redirect straight back to the app (e.g. carrying an error)
 */
const passFrontDoor = async (journey, authorizeUrl) => {
  const gate = await follow('GET', authorizeUrl, undefined, journey.redirectOrigin)
  if (gate.redirect) return gate
  const crumb = inputValue(String(gate.page.data), 'crumb')
  if (!crumb) throw new Error(describeStoppedPage(gate.page, 'the idphub check-js page'))

  const checkJsUrl = new URL('/registration/journey/check-js/check-js-enabled', gate.url).href
  const resume = await follow(
    'POST',
    checkJsUrl,
    form({ crumb, checkJs: '' }, { referer: checkJsUrl }),
    journey.redirectOrigin
  )
  if (resume.redirect) return resume
  const html = String(resume.page.data)
  const callbackUrl = /<form[^>]*action="([^"]*authresp[^"]*)"/.exec(html)?.[1]?.replaceAll('&amp;', '&')
  const code = inputValue(html, 'code')
  if (!callbackUrl || !code) throw new Error(describeStoppedPage(resume.page, 'the idphub callback form'))

  return follow(
    'POST',
    callbackUrl,
    form({ code, state: inputValue(html, 'state') }, { referer: `${journey.b2cOrigin}/` }),
    journey.redirectOrigin
  )
}

/**
 * Lists the businesses the business picker offers, the way its page script does: POST the page's
 * ids to idphub with the page's bearer token, refreshing that token once on a 401.
 *
 * @returns {Promise<Array<{ id: string|number, organisationName: string, organisationId: string }>>}
 * @throws {Error} if idphub doesn't return a relationships list
 */
const listRelationships = async (journey, fields) => {
  const field = (id) => fields.find((f) => f.id === id)?.value || ''
  const fetchList = (bearerToken) =>
    request('POST', `${journey.idphubOrigin}/idphub/auth/user-relationships`, {
      headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${bearerToken}` },
      body: JSON.stringify({
        id: field('objectId'),
        serviceId: field('serviceId'),
        correlationId: field('correlationId'),
        sessionId: field('sessionId'),
        amr: field('amrExecuted'),
        ...(field('dataStoreId') ? { dataStoreId: field('dataStoreId') } : {})
      })
    })

  let response = await fetchList(field('bearerToken'))
  if (response.status === 401) {
    const refreshed = await request(
      'POST',
      `${journey.idphubOrigin}/idphub/token`,
      form(
        {
          grant_type: 'refresh_token',
          refresh_token: field('refreshToken'),
          correlationId: field('correlationId'),
          sessionId: field('sessionId')
        },
        { accept: 'application/json' }
      )
    )
    response = await fetchList(tryJson(refreshed.data).accessToken || '')
  }
  const relationships = tryJson(response.data).relationships
  if (response.status !== 200 || !Array.isArray(relationships)) {
    throw new Error(`HTTP ${response.status}: ${String(response.data).slice(0, 200)}`)
  }
  return relationships
}

/**
 * Picks the business: DEFRA_ID_RELATIONSHIP_ID if the account has it, otherwise the account's
 * only one. If the list can't be fetched, DEFRA_ID_RELATIONSHIP_ID is used unchecked.
 *
 * @returns {Promise<string>} the relationship id to submit
 * @throws {Error} listing the account's businesses when none can be picked
 */
const chooseRelationship = async (journey, fields) => {
  const { relationshipId } = journey.config
  let relationships
  try {
    relationships = await listRelationships(journey, fields)
  } catch (cause) {
    if (!relationshipId) {
      throw new Error(`Could not list the account's businesses (${cause.message}) - set DEFRA_ID_RELATIONSHIP_ID`)
    }
    console.error(`Business lookup failed (${cause.message}) - using DEFRA_ID_RELATIONSHIP_ID unchecked`)
    return relationshipId
  }
  const options = relationships.map((r) => `${r.id}: ${r.organisationName} (SBI ${r.organisationId})`).join('; ')
  if (relationshipId) {
    if (relationships.some((r) => String(r.id) === String(relationshipId))) return relationshipId
    throw new Error(`DEFRA_ID_RELATIONSHIP_ID ${relationshipId} is not one of this account's businesses: ${options}`)
  }
  if (relationships.length === 1) return String(relationships[0].id)
  throw new Error(`This account has several businesses - set DEFRA_ID_RELATIONSHIP_ID to one of: ${options}`)
}

/**
 * Builds the submission for a page, as B2C's own page script does: every field with its pre-filled
 * value in page order (read-only fields included - the business picker rejects the step with a
 * generic AADB2C error if any are missing), then request_type. The sign-in page gets the CRN and
 * password, the business picker the chosen business.
 *
 * @returns {Promise<URLSearchParams>} the form body
 */
const pageSubmission = async (journey, fields) => {
  const body = new URLSearchParams()
  for (const { id, value } of fields) body.set(id, value)
  const ids = new Set(fields.map((f) => f.id))
  if (ids.has('crn')) {
    body.set('crn', journey.config.crn)
    body.set('password', journey.config.password)
  } else if (ids.has('currentRelationshipId')) {
    body.set('currentRelationshipId', await chooseRelationship(journey, fields))
  }
  body.set('request_type', 'RESPONSE')
  return body
}

/**
 * Submits a B2C page (POST SelfAsserted) and confirms it (GET confirmed).
 *
 * @returns {Promise<{ page?: import('axios').AxiosResponse, redirect?: URL }>} the next page, or
 *   the redirect back to the app
 * @throws {Error} if B2C rejects the submission
 */
const submitPage = async (journey, settings, body) => {
  const tenantUrl = `${journey.b2cOrigin}${settings.hosts.tenant}`
  const query = `tx=${encodeURIComponent(settings.transId)}&p=${settings.hosts.policy}`
  const submitted = await request('POST', `${tenantUrl}/SelfAsserted?${query}`, {
    headers: {
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'x-csrf-token': settings.csrf,
      'x-requested-with': 'XMLHttpRequest',
      referer: `${tenantUrl}/`
    },
    body: body.toString()
  })
  const result = tryJson(submitted.data)
  if (submitted.status !== 200 || (result.status && String(result.status) !== '200')) {
    throw new Error(
      `Defra ID rejected the page (HTTP ${submitted.status}, status ${result.status || 'none'}): ` +
        (result.message || String(submitted.data).slice(0, 200))
    )
  }
  return follow(
    'GET',
    `${tenantUrl}/api/${settings.api}/confirmed?rememberMe=false&csrf_token=${settings.csrf}&${query}`,
    undefined,
    journey.redirectOrigin
  )
}

/**
 * Drives the Defra ID sign-in journey (front door, then SelfAsserted rounds).
 *
 * @param {string} authorizeUrl - the full authorize request URL
 * @param {{ wellKnownUrl: string, crn: string, password: string, redirectUrl: string,
 *   relationshipId?: string }} config - the script config
 * @returns {Promise<URL>} the redirect back to `redirect_uri`, carrying the auth code and state (or
 *   B2C's error and error_description)
 * @throws {Error} if a page is rejected or the journey stops on a page it doesn't recognise
 */
const signIn = async (authorizeUrl, config) => {
  const journey = {
    config,
    b2cOrigin: new URL(authorizeUrl).origin,
    idphubOrigin: new URL(config.wellKnownUrl).origin,
    redirectOrigin: new URL(config.redirectUrl).origin
  }
  // B2C also wants the policy as p; it is the path segment after the tenant. The business is chosen
  // on the business picker, not with relationshipId on authorize (which changes the journey)
  const policy = new URL(authorizeUrl).pathname.split('/')[2]
  return completeRounds(journey, await passFrontDoor(journey, `${authorizeUrl}&p=${policy}`))
}

/**
 * Submits B2C pages one after another - each round needs the page the previous one returned -
 * until B2C redirects back to the app.
 *
 * @param {object} journey - the journey's config and origins
 * @param {{ page?: import('axios').AxiosResponse, redirect?: URL }} step - the current page, or the
 *   redirect back to the app
 * @param {number} round - how many pages have been submitted so far
 * @returns {Promise<URL>} the redirect back to `redirect_uri`
 * @throws {Error} if a page is rejected or unrecognised, or MAX_ROUNDS pass without a redirect
 */
const completeRounds = async (journey, step, round = 0) => {
  if (step.redirect) return step.redirect
  if (round >= MAX_ROUNDS) throw new Error(`Completed ${MAX_ROUNDS} sign-in rounds without a redirect back to the app`)
  const html = String(step.page.data)
  const settings = pageVar(html, 'SETTINGS')
  if (!settings?.csrf || !settings.transId || !settings.hosts?.tenant) {
    throw new Error(describeStoppedPage(step.page, `a Defra ID sign-in page (round ${round})`))
  }
  const fields = pageFields(html)
  let next
  try {
    next = await submitPage(journey, settings, await pageSubmission(journey, fields))
  } catch (error) {
    // name the page so a rejection can be traced to the step that caused it
    error.message += ` [round ${round}, page fields: ${fields.map((f) => f.id).join(', ') || 'none'}]`
    throw error
  }
  return completeRounds(journey, next, round + 1)
}

module.exports = { signIn }
