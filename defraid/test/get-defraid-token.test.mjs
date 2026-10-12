// Runs get-defraid-token.js as entrypoint.sh does - as a child process configured by environment
// variables - against the stub started by global-setup.mjs.
//
// Tests 1-3 assume the stub's Basic mode data (three organisations for every CRN); against a stub
// with other data, set CRN and RELATIONSHIP_ID to a matching person and organisation.

import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, inject, test } from 'vitest'

const SCRIPT = fileURLToPath(new URL('../get-defraid-token.js', import.meta.url))
const CRN = process.env.CRN || '1102823449'
const RELATIONSHIP_ID = process.env.RELATIONSHIP_ID || '5900001'

const stubUrl = inject('stubUrl')
const wellKnownUrl = `${stubUrl}/idphub/b2c/b2c_1a_cui_cpdev_signupsigninsfi/.well-known/openid-configuration`

// runs the script with a valid config; overrides replace values, and an undefined override removes one
const runScript = (overrides = {}) => {
  const env = {
    PATH: process.env.PATH,
    DEFRA_ID_WELL_KNOWN_URL: wellKnownUrl,
    DEFRA_ID_CRN: CRN,
    DEFRA_ID_PASSWORD: 'test',
    DEFRA_ID_CLIENT_ID: 'fcp-dal-api-perf-test',
    DEFRA_ID_CLIENT_SECRET: 'test',
    DEFRA_ID_SERVICE_ID: 'fcp-dal-api-perf-test',
    DEFRA_ID_REDIRECT_URL: 'https://example.com/auth/sign-in-oidc',
    DEFRA_ID_RELATIONSHIP_ID: RELATIONSHIP_ID,
    ...overrides
  }
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key]

  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT], { env }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr })
    })
  })
}

const decodeClaims = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())

describe('get-defraid-token.js', () => {
  test('prints a token for the CRN and organisation', async () => {
    const { code, stdout, stderr } = await runScript()

    expect(code, stderr).toBe(0)
    expect(stdout).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+\n$/)
    const claims = decodeClaims(stdout.trim())
    expect(String(claims.contactId)).toBe(CRN)
    expect(claims.currentRelationshipId).toBe(RELATIONSHIP_ID)
    expect(claims.exp * 1000).toBeGreaterThan(Date.now())
  })

  // entrypoint.sh treats anything on stdout as the token, so every failure must leave it empty
  test.each([
    {
      name: 'asks for a relationship id when the CRN has several organisations',
      overrides: { DEFRA_ID_RELATIONSHIP_ID: undefined },
      message: 'set DEFRA_ID_RELATIONSHIP_ID'
    },
    {
      name: 'rejects an organisation the CRN does not have',
      overrides: { DEFRA_ID_RELATIONSHIP_ID: '9999999' },
      message: 'set DEFRA_ID_RELATIONSHIP_ID'
    },
    {
      name: 'rejects missing config',
      overrides: { DEFRA_ID_CLIENT_SECRET: undefined },
      message: 'Missing Defra ID stub config: clientSecret'
    },
    {
      name: 'fails cleanly on a bad discovery URL',
      overrides: { DEFRA_ID_WELL_KNOWN_URL: `${stubUrl}/no-such-path` },
      message: 'ERROR getting Defra ID token'
    }
  ])('$name', async ({ overrides, message }) => {
    const { code, stdout, stderr } = await runScript(overrides)

    expect(code).not.toBe(0)
    expect(stdout).toBe('')
    expect(stderr).toContain(message)
  })
})
