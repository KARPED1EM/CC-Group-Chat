import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ensureAuthToken,
  generateAuthToken,
  getAuthTokenPath,
  getBrokerPort,
  readAuthToken,
  readStateFile,
  writeAuthToken,
  writeStateFile,
  removeStateFile,
  STATE_FILE_VERSION,
  type BrokerStateFile,
} from '../src/daemon.ts'

const sample: BrokerStateFile = {
  version: STATE_FILE_VERSION,
  pid: 12345,
  port: 47734,
  startedAt: 1_700_000_000_000,
}

describe('daemon state file', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cc-group-chat-test-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test('readStateFile returns null when the file is missing', async () => {
    expect(await readStateFile(dir)).toBeNull()
  })

  test('writeStateFile then readStateFile round-trips', async () => {
    await writeStateFile(dir, sample)
    expect(await readStateFile(dir)).toEqual(sample)
  })

  test('writeStateFile is atomic: no stray .tmp file remains', async () => {
    await writeStateFile(dir, sample)
    expect(await readdir(dir)).toEqual(['broker.json'])
  })

  test('writeStateFile creates the directory if missing', async () => {
    const nested = join(dir, 'nested', 'dir')
    await writeStateFile(nested, sample)
    expect(await readStateFile(nested)).toEqual(sample)
  })

  test('removeStateFile removes an existing file', async () => {
    await writeStateFile(dir, sample)
    await removeStateFile(dir)
    expect(await readStateFile(dir)).toBeNull()
  })

  test('removeStateFile on a missing file is a no-op', async () => {
    await expect(removeStateFile(dir)).resolves.toBeUndefined()
  })

  test('readStateFile returns null for malformed JSON', async () => {
    await writeFile(join(dir, 'broker.json'), '{not valid json', 'utf8')
    expect(await readStateFile(dir)).toBeNull()
  })

  test('readStateFile returns null for valid JSON missing required fields', async () => {
    await writeFile(join(dir, 'broker.json'), JSON.stringify({ port: 1234 }), 'utf8')
    expect(await readStateFile(dir)).toBeNull()
  })
})

describe('getBrokerPort', () => {
  test('is in the [47000, 48000) range', () => {
    const port = getBrokerPort('alice')
    expect(port).toBeGreaterThanOrEqual(47000)
    expect(port).toBeLessThan(48000)
  })

  test('is deterministic for the same username', () => {
    expect(getBrokerPort('alice')).toBe(getBrokerPort('alice'))
  })

  test('differs across distinct usernames (overwhelmingly)', () => {
    // With 1000 slots a single collision is unlikely but possible; pick names
    // chosen to avoid known collisions in the sha256 prefix.
    expect(getBrokerPort('alice')).not.toBe(getBrokerPort('bob'))
    expect(getBrokerPort('carol')).not.toBe(getBrokerPort('dave'))
  })
})

describe('auth token IO', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cc-auth-test-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test('readAuthToken returns null when the file is missing', async () => {
    expect(await readAuthToken(dir)).toBeNull()
  })

  test('writeAuthToken then readAuthToken round-trips', async () => {
    await writeAuthToken(dir, 'deadbeef')
    expect(await readAuthToken(dir)).toBe('deadbeef')
  })

  test('readAuthToken strips surrounding whitespace', async () => {
    await writeFile(getAuthTokenPath(dir), '  spaced  \n', 'utf8')
    expect(await readAuthToken(dir)).toBe('spaced')
  })

  test('readAuthToken returns null for empty content', async () => {
    await writeFile(getAuthTokenPath(dir), '   \n', 'utf8')
    expect(await readAuthToken(dir)).toBeNull()
  })

  test('writeAuthToken creates the directory if missing', async () => {
    const nested = join(dir, 'nested')
    await writeAuthToken(nested, 'tok')
    expect(await readAuthToken(nested)).toBe('tok')
  })

  test('generateAuthToken returns a 64-char hex string', () => {
    const t = generateAuthToken()
    expect(t).toMatch(/^[0-9a-f]{64}$/)
  })

  test('ensureAuthToken returns the existing token without overwriting', async () => {
    await writeAuthToken(dir, 'pre-existing')
    const t = await ensureAuthToken(dir)
    expect(t).toBe('pre-existing')
    expect(await readAuthToken(dir)).toBe('pre-existing')
  })

  test('ensureAuthToken generates and persists a token when none exists', async () => {
    const t = await ensureAuthToken(dir)
    expect(t).toMatch(/^[0-9a-f]{64}$/)
    expect(await readAuthToken(dir)).toBe(t)
  })

  test('ensureAuthToken is idempotent across calls', async () => {
    const first = await ensureAuthToken(dir)
    const second = await ensureAuthToken(dir)
    expect(second).toBe(first)
  })
})
