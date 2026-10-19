// Minimal HTTP client for the sign-in journeys: a cookie jar per host (both the stub and Defra ID
// keep the auth request in session cookies), browser-like default headers, no automatic redirects,
// and retries on dropped connections.

const axios = require('axios')
const { setTimeout: sleep } = require('node:timers/promises')

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const jars = {}
const storeCookies = (host, headers) => {
  for (const line of headers['set-cookie'] || []) {
    const pair = line.split(';')[0]
    const i = pair.indexOf('=')
    if (i > 0) {
      jars[host] = jars[host] || {}
      jars[host][pair.slice(0, i).trim()] = pair.slice(i + 1).trim()
    }
  }
}
const cookieHeader = (host) =>
  Object.entries(jars[host] || {})
    .map(([name, value]) => `${name}=${value}`)
    .join('; ')

// DEFRA_ID_DEBUG=1 traces each request to stderr: method, URL (query string dropped, as it can
// carry codes), status and redirect target
const trace = (method, url, response) => {
  if (!process.env.DEFRA_ID_DEBUG) return
  const strip = (value) => value && value.split('?')[0]
  const location = response.headers.location ? ` -> ${strip(response.headers.location)}` : ''
  console.error(`[debug] ${method} ${strip(url)} ${response.status}${location}`)
}

// CDP and Defra ID hosts occasionally drop connections; a short pause and retry recovers these
const request = async (method, url, { body, headers = {} } = {}, retriesLeft = 3) => {
  const host = new URL(url).host
  try {
    const cookie = cookieHeader(host)
    const response = await axios({
      method,
      url,
      data: body,
      maxRedirects: 0,
      validateStatus: () => true,
      transformResponse: [(data) => data],
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        ...(cookie ? { cookie } : {}),
        ...headers
      }
    })
    storeCookies(host, response.headers)
    trace(method, url, response)
    return response
  } catch (cause) {
    if (retriesLeft <= 0) throw new Error(`${method} ${url} failed: ${cause.message}`)
    await sleep(2000)
    return request(method, url, { body, headers }, retriesLeft - 1)
  }
}

const form = (fields, headers = {}) => ({
  headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
  body: new URLSearchParams(fields).toString()
})

module.exports = { request, form }
