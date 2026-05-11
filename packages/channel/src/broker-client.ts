import {
  getBrokerPort,
  getDefaultStateDir,
  readAuthToken,
} from '@cc-group-chat/shared'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

export interface BrokerConnection {
  readonly ws: WebSocket
  readonly authToken: string
  readonly port: number
}

export interface ConnectToBrokerOptions {
  /** Defaults to `~/.cc-group-chat`. */
  readonly stateDir?: string
  /** Override the username-derived broker port. Used by tests. */
  readonly port?: number
  /** Override for tests. Default spawns the broker daemon detached. */
  readonly spawn?: () => void
  /** How long to wait for a freshly-spawned broker to come up. Default 5000ms. */
  readonly timeoutMs?: number
  /** How often to poll the broker port while waiting. Default 100ms. */
  readonly pollIntervalMs?: number
}

const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_POLL_MS = 100

/**
 * Open a WebSocket connection to the local broker daemon.
 *
 * Discovery is purely port-based: we know the broker's port from the local
 * username, try to connect, and if nothing answers we spawn a daemon and
 * retry. The `~/.cc-group-chat/broker.json` state file is metadata only; it
 * is not consulted for discovery.
 *
 * The returned connection includes the per-user auth token read from
 * `~/.cc-group-chat/auth-token`, which the caller passes to the `join` RPC.
 */
export async function connectToBroker(opts: ConnectToBrokerOptions = {}): Promise<BrokerConnection> {
  const stateDir = opts.stateDir ?? getDefaultStateDir()
  const port = opts.port ?? getBrokerPort()
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS
  const doSpawn = opts.spawn ?? defaultSpawn

  let ws = await tryOpen(port)
  if (!ws) {
    doSpawn()
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await sleep(pollIntervalMs)
      ws = await tryOpen(port)
      if (ws) break
    }
    if (!ws) {
      throw new Error(`cc-group-chat: broker did not come up on port ${port} within ${timeoutMs}ms`)
    }
  }

  const authToken = await readAuthToken(stateDir)
  if (!authToken) {
    ws.close()
    throw new Error(
      `cc-group-chat: broker is up but auth token not found at ${stateDir}/auth-token`,
    )
  }

  return { ws, authToken, port }
}

function tryOpen(port: number): Promise<WebSocket | null> {
  return new Promise((resolveP) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    const cleanup = (): void => {
      ws.removeEventListener('open', onOpen)
      ws.removeEventListener('error', onFail)
      ws.removeEventListener('close', onFail)
    }
    const onOpen = (): void => { cleanup(); resolveP(ws) }
    const onFail = (): void => { cleanup(); resolveP(null) }
    ws.addEventListener('open', onOpen, { once: true })
    ws.addEventListener('error', onFail, { once: true })
    ws.addEventListener('close', onFail, { once: true })
  })
}

/**
 * Default spawn: launches the broker daemon as a detached subprocess so it
 * outlives this channel server.
 *
 * Two deployment shapes resolve here:
 *   - Production (plugin installed via marketplace): both bundles live next
 *     to each other in `bin/` and Bun runs `bin/broker.js` directly.
 *   - Development (running from source): the channel source lives at
 *     `packages/channel/src` and the broker daemon source at
 *     `packages/broker/src/daemon.ts`, two levels up.
 */
function defaultSpawn(): void {
  const here = import.meta.dirname
  const bundle = resolve(here, 'broker.js')
  const daemonPath = existsSync(bundle)
    ? bundle
    : resolve(here, '../../broker/src/daemon.ts')
  Bun.spawn({
    cmd: ['bun', daemonPath],
    stdout: 'ignore',
    stderr: 'ignore',
    stdin: 'ignore',
  }).unref()
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}
