import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  STATE_FILE_VERSION,
  writeStateFile,
  removeStateFile,
  type BrokerStateFile,
} from '@cc-group-chat/shared'
import { Broker, startWsServer, type RunningWsServer } from '@cc-group-chat/broker'
import { connectToBroker } from '../src/broker-client.ts'

describe('connectToBroker', () => {
  let dir: string
  let server: RunningWsServer

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cc-cb-test-'))
    server = startWsServer(new Broker())
  })

  afterEach(async () => {
    await server.stop()
    await rm(dir, { recursive: true, force: true })
  })

  async function writeServerState(): Promise<void> {
    const state: BrokerStateFile = {
      version: STATE_FILE_VERSION,
      pid: process.pid,
      port: server.port,
      startedAt: Date.now(),
    }
    await writeStateFile(dir, state)
  }

  test('connects to an existing broker advertised in the state file', async () => {
    await writeServerState()
    const conn = await connectToBroker({
      stateDir: dir,
      spawn: () => { throw new Error('should not spawn when broker is already up') },
    })
    expect(conn.ws.readyState).toBe(WebSocket.OPEN)
    expect(conn.state.port).toBe(server.port)
    conn.ws.close()
  })

  test('falls back to spawning when no state file exists', async () => {
    let spawned = false
    const conn = await connectToBroker({
      stateDir: dir,
      spawn: () => {
        spawned = true
        void writeServerState()
      },
      pollIntervalMs: 20,
      timeoutMs: 2_000,
    })
    expect(spawned).toBe(true)
    expect(conn.ws.readyState).toBe(WebSocket.OPEN)
    conn.ws.close()
  })

  test('falls back to spawning when state file points at an unreachable port', async () => {
    await writeStateFile(dir, {
      version: STATE_FILE_VERSION,
      pid: 999_999,
      port: 49_999,
      startedAt: 0,
    })
    let spawned = false
    const conn = await connectToBroker({
      stateDir: dir,
      spawn: () => {
        spawned = true
        void writeServerState()
      },
      pollIntervalMs: 20,
      timeoutMs: 2_000,
    })
    expect(spawned).toBe(true)
    expect(conn.ws.readyState).toBe(WebSocket.OPEN)
    expect(conn.state.port).toBe(server.port)
    conn.ws.close()
  })

  test('throws when the broker does not come up within timeout', async () => {
    await removeStateFile(dir)
    await expect(connectToBroker({
      stateDir: dir,
      spawn: () => { /* never advertise */ },
      pollIntervalMs: 20,
      timeoutMs: 100,
    })).rejects.toThrow(/did not come up/)
  })
})
