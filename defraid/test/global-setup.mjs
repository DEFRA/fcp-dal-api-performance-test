// Starts the FCP Defra ID stub in Docker for the tests, unless STUB_URL points at a running one
// (e.g. https://fcp-defra-id-stub.dev.cdp-int.defra.cloud - CDP stubs only work from inside CDP)

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const STUB_PORT = process.env.STUB_PORT ?? '3007'
const STUB_IMAGE = process.env.STUB_IMAGE ?? 'defradigital/fcp-defra-id-stub'

// docker is run from a fixed location rather than looked up on PATH; set DOCKER_BIN if it lives elsewhere
const DOCKER_LOCATIONS = ['/usr/local/bin/docker', '/opt/homebrew/bin/docker', '/usr/bin/docker']

const findDocker = () => {
  const docker = process.env.DOCKER_BIN ?? DOCKER_LOCATIONS.find((location) => existsSync(location))
  if (!docker) {
    throw new Error(`docker not found in ${DOCKER_LOCATIONS.join(', ')} - set DOCKER_BIN to its full path`)
  }
  return docker
}

// checks once a second, one check at a time, until healthy or out of attempts
const waitForHealthy = async (url, attemptsLeft = 60) => {
  let problem
  try {
    const response = await fetch(`${url}/health`)
    if (response.ok) return
    problem = `HTTP ${response.status}`
  } catch (error) {
    // expected while the container is starting; reported if it never becomes healthy
    problem = error.cause?.code ?? error.message
  }
  if (attemptsLeft <= 1) {
    throw new Error(`Stub at ${url} did not become healthy (last problem: ${problem})`)
  }
  await sleep(1000)
  return waitForHealthy(url, attemptsLeft - 1)
}

export default async function setup ({ provide }) {
  if (process.env.STUB_URL) {
    provide('stubUrl', process.env.STUB_URL)
    return
  }

  const docker = findDocker()
  const stubUrl = `http://localhost:${STUB_PORT}`
  const container = `defra-id-stub-test-${process.pid}`
  // the host overrides make the stub advertise the mapped port, and localhost rather than
  // host.docker.internal for the token endpoint
  execFileSync(docker, [
    'run', '-d', '--rm', '--platform', 'linux/amd64', '--name', container, '-p', `${STUB_PORT}:3007`,
    '-e', `WELL_KNOWN_HOST_OVERRIDE=${stubUrl}`, // authorize (browser) URLs
    '-e', `WELL_KNOWN_API_HOST_OVERRIDE=${stubUrl}`, // token endpoint (server-to-server) URLs
    STUB_IMAGE
  ], { stdio: 'ignore' })

  // spawnSync rather than execFileSync so a container that has already exited doesn't hide the real error
  const stop = () => spawnSync(docker, ['stop', container], { stdio: 'ignore' })
  try {
    await waitForHealthy(stubUrl)
  } catch (error) {
    stop()
    throw error
  }

  provide('stubUrl', stubUrl)
  return stop
}
