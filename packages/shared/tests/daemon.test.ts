import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readStateFile,
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
