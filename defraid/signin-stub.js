// Sign-in journey for the FCP Defra ID stub (https://github.com/DEFRA/fcp-defra-id-stub):
// authorize -> CRN/password -> organisation -> redirect back with the code.
//
// The stub only checks that client id, client secret, service id and password are present, so any
// values work. In its default (Basic) mode any 10 digit CRN is accepted and every CRN has the same
// three mock organisations (5900001, 5900002, 5900003).

const { request, form } = require('./http')

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

/**
 * Drives the stub's sign-in journey (authorize -> CRN/password -> organisation).
 *
 * @param {string} authorizeUrl - the full authorize request URL
 * @param {{ crn: string, password: string, relationshipId?: string }} config - the credentials to
 *   sign in with, and the organisation to sign in as
 * @returns {Promise<URL>} the redirect back to `redirect_uri`, carrying the auth code and state
 * @throws {Error} if the journey leaves the stub too early or stops on a stub page (e.g. sign in
 *   rejected, or an organisation must be chosen because DEFRA_ID_RELATIONSHIP_ID is not set)
 */
const signIn = async (authorizeUrl, config) => {
  // the stub picks the organisation from relationshipId on the authorize request
  if (config.relationshipId) authorizeUrl += `&${new URLSearchParams({ relationshipId: config.relationshipId })}`

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

module.exports = { signIn }
