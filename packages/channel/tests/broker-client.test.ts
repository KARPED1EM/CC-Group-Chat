import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeAuthToken } from '@cc-group-chat/shared'
import { Broker, startWsServer, type RunningWsServer } from '@cc-group-chat/broker'
import { connectToBroker } from '../src/broker-client.ts'

describe('connectToBroker', () => {
  let dir: string
  let server: RunningWsServer
  const aux: RunningWsServer[] = []

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cc-cb-test-'))
    server = startWsServer(new Broker())
    await writeAuthToken(dir, 'test-token')
  })

  afterEach(async () => {
    await server.stop()
    while (aux.length > 0) {
      const s = aux.pop()
      if (s) await s.stop()
    }
    await rm(dir, { recursive: true, force: true })
  })

  test('connects on first try when the broker is already listening', async () => {
    const conn = await connectToBroker({
      stateDir: dir,
      port: server.port,
      spawn: () => { throw new Error('should not spawn when broker is already up') },
    })
    expect(conn.ws.readyState).toBe(WebSocket.OPEN)
    expect(conn.port).toBe(server.port)
    expect(conn.authToken).toBe('test-token')
    conn.ws.close()
  })

  test('spawns when nothing is listening and connects after the spawn brings the broker up', async () => {
    const newPort = server.port + 1000
    let spawnedServer: RunningWsServer | null = null
    const conn = await connectToBroker({
      stateDir: dir,
      port: newPort,
      spawn: () => {
        spawnedServer = startWsServer(new Broker(), { port: newPort })
        aux.push(spawnedServer)
      },
      pollIntervalMs: 20,
      timeoutMs: 2_000,
    })
    expect(spawnedServer).not.toBeNull()
    expect(conn.ws.readyState).toBe(WebSocket.OPEN)
    expect(conn.port).toBe(newPort)
    conn.ws.close()
  })

  test('throws when the broker is up but the auth token file is missing', async () => {
    await rm(join(dir, 'auth-token'), { force: true })
    await expect(connectToBroker({
      stateDir: dir,
      port: server.port,
      spawn: () => { throw new Error('should not spawn') },
    })).rejects.toThrow(/auth token not found/)
  })

  test('throws when nothing comes up within the timeout', async () => {
    await expect(connectToBroker({
      stateDir: dir,
      port: server.port + 999,
      spawn: () => { /* never advertise */ },
      pollIntervalMs: 20,
      timeoutMs: 100,
    })).rejects.toThrow(/did not come up/)
  })
})
