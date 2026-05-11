// State file used by the broker daemon to advertise its address and by the
// channel client to discover it. The file lives at `<stateDir>/broker.json`
// where `stateDir` defaults to `~/.cc-group-chat`. Paths are passed in
// explicitly so tests can substitute a temp directory.

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const STATE_FILE_NAME = 'broker.json'
const TMP_SUFFIX = '.tmp'

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
