import { readStateFile, type BrokerStateFile } from '@cc-group-chat/shared'
import { resolve } from 'node:path'

export interface BrokerConnection {
  readonly ws: WebSocket
  readonly state: BrokerStateFile
}

export interface ConnectToBrokerOptions {
  readonly stateDir: string
  /** Override for tests. Default spawns the broker daemon detached. */
  readonly spawn?: () => void
  /** How long to wait for a freshly-spawned broker to come up. Default 5000ms. */
  readonly timeoutMs?: number
  /** How often to poll for the state file / open the WebSocket. Default 100ms. */
  readonly pollIntervalMs?: number
}

const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_POLL_MS = 100

/**
 * Open a WebSocket connection to the local broker daemon.
 *
 * Tries the broker advertised in the state file first. If the file is missing
 * or the advertised port no longer answers, spawns a new broker and waits for
 * it to register itself.
 */
export async function connectToBroker(opts: ConnectToBrokerOptions): Promise<BrokerConnection> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS
  const doSpawn = opts.spawn ?? defaultSpawn

  const existing = await readStateFile(opts.stateDir)
  if (existing) {
    const ws = await tryOpen(existing.port)
    if (ws) return { ws, state: existing }
  }

  doSpawn()

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(pollIntervalMs)
    const state = await readStateFile(opts.stateDir)
    if (state) {
      const ws = await tryOpen(state.port)
      if (ws) return { ws, state }
    }
  }
  throw new Error(`cc-group-chat: broker did not come up within ${timeoutMs}ms`)
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
 * outlives this channel server. The daemon entry is resolved relative to this
 * file inside the monorepo layout (`packages/channel/src` →
 * `packages/broker/src/daemon.ts`).
 */
function defaultSpawn(): void {
  const daemonPath = resolve(import.meta.dirname, '../../broker/src/daemon.ts')
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
