// Broker discovery and credentials shared between the daemon and channel-side
// clients.
//
// Discovery uses a username-derived TCP port (`getBrokerPort`) — the kernel's
// bind/listen is the source of truth for "is there a broker", and the port is
// per-user so distinct OS users cannot accidentally share a chat. The
// `broker.json` state file is kept as observation metadata only (pid,
// startedAt, port for ops/debugging); it is not on the discovery critical
// path.
//
// Cross-user safety is reinforced by an auth token at
// `<stateDir>/auth-token`, written `0600` on POSIX. Only processes the OS
// trusts to read the user's home can read it; the channel client supplies it
// to `join` and the broker rejects mismatches.

import { createHash, randomBytes } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'

const STATE_FILE_NAME = 'broker.json'
const AUTH_TOKEN_FILE_NAME = 'auth-token'
const TMP_SUFFIX = '.tmp'

const PORT_BASE = 47000
const PORT_RANGE = 1000

export const STATE_FILE_VERSION = '0'

export interface BrokerStateFile {
  /** Format version. Bumped whenever this shape changes. */
  readonly version: string
  /** PID of the broker daemon process. */
  readonly pid: number
  /** Local TCP port the broker WebSocket server is listening on. */
  readonly port: number
  /** Unix milliseconds at which the broker started. */
  readonly startedAt: number
}

export function getDefaultStateDir(): string {
  return join(homedir(), '.cc-group-chat')
}

/**
 * Derive the broker's TCP port from the local username. Distinct users on a
 * shared host get distinct ports, so the kernel-level bind contention also
 * doubles as cross-user isolation.
 */
export function getBrokerPort(username?: string): number {
  const name = username ?? userInfo().username
  const digest = createHash('sha256').update(name).digest()
  return PORT_BASE + (digest.readUInt32BE(0) % PORT_RANGE)
}

/**
 * Derive a deterministic room id from the current working directory. Sessions
 * launched in the same project directory naturally rendezvous in the same
 * room without any explicit configuration. The path is canonicalised through
 * `realpathSync` so symlinks and case differences on Windows do not
 * fragment the room id.
 */
export function getDefaultRoomId(cwd: string = process.cwd()): string {
  let canonical = cwd
  try {
    canonical = realpathSync(cwd)
  } catch {
    // Fall back to the supplied path if it cannot be canonicalised.
  }
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 8)
  return `auto-${hash}`
}

// ===== State file (observation metadata only — not on discovery path) =====

/** Returns null when the file is absent or malformed. Never throws. */
export async function readStateFile(stateDir: string): Promise<BrokerStateFile | null> {
  const filePath = join(stateDir, STATE_FILE_NAME)
  try {
    const raw = await readFile(filePath, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    return isBrokerStateFile(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Atomic write: writes to a sibling `.tmp` then renames over the target. */
export async function writeStateFile(stateDir: string, state: BrokerStateFile): Promise<void> {
  await mkdir(stateDir, { recursive: true })
  const filePath = join(stateDir, STATE_FILE_NAME)
  const tmpPath = filePath + TMP_SUFFIX
  await writeFile(tmpPath, JSON.stringify(state, null, 2), 'utf8')
  await rename(tmpPath, filePath)
}

/** Best-effort removal. Returns silently if the file does not exist. */
export async function removeStateFile(stateDir: string): Promise<void> {
  const filePath = join(stateDir, STATE_FILE_NAME)
  await rm(filePath, { force: true }).catch(() => { /* ignore */ })
}

// ===== Auth token =====

export function getAuthTokenPath(stateDir: string): string {
  return join(stateDir, AUTH_TOKEN_FILE_NAME)
}

/** Returns the token string or null if the file does not exist. */
export async function readAuthToken(stateDir: string): Promise<string | null> {
  try {
    const raw = await readFile(getAuthTokenPath(stateDir), 'utf8')
    const trimmed = raw.trim()
    return trimmed.length > 0 ? trimmed : null
  } catch {
    return null
  }
}

/**
 * Writes the token with `0600` permissions. On Windows the mode is honoured
 * by the runtime where supported; in any case the file sits in the user's
 * home directory and is protected by the directory ACLs.
 */
export async function writeAuthToken(stateDir: string, token: string): Promise<void> {
  await mkdir(stateDir, { recursive: true })
  await writeFile(getAuthTokenPath(stateDir), token, { encoding: 'utf8', mode: 0o600 })
}

export function generateAuthToken(): string {
  return randomBytes(32).toString('hex')
}

/** Read the persisted token; generate and persist a fresh one if missing. */
export async function ensureAuthToken(stateDir: string): Promise<string> {
  const existing = await readAuthToken(stateDir)
  if (existing) return existing
  const fresh = generateAuthToken()
  await writeAuthToken(stateDir, fresh)
  return fresh
}

function isBrokerStateFile(x: unknown): x is BrokerStateFile {
  if (typeof x !== 'object' || x === null) return false
  const o = x as Record<string, unknown>
  return (
    typeof o.version === 'string' &&
    typeof o.pid === 'number' &&
    typeof o.port === 'number' &&
    typeof o.startedAt === 'number'
  )
}
