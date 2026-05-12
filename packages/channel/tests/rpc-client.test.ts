import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Broker, startWsServer, type RunningWsServer } from '@cc-group-chat/broker'
import { writeAuthToken, METHOD } from '@cc-group-chat/shared'
import { connectToBroker } from '../src/broker-client.ts'
import { RpcClient, RpcError } from '../src/rpc-client.ts'

describe('RpcClient', () => {
  let dir: string
  let server: RunningWsServer
  let ws: WebSocket
  let rpc: RpcClient
  let received: Array<{ method: string; params: unknown }>
  const aux: Array<() => void> = []

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cc-rpc-test-'))
    server = startWsServer(new Broker({ room: { now: () => 1_700_000_000_000 }, pushBatchMs: 0 }))
    await writeAuthToken(dir, 'test-token')
    const conn = await connectToBroker({
      stateDir: dir,
      port: server.port,
      spawn: () => { throw new Error('spawn should not run in this test') },
    })
    ws = conn.ws
    received = []
    rpc = new RpcClient({
      ws,
      onNotification: (method, params) => received.push({ method, params }),
    })
  })

  afterEach(async () => {
    while (aux.length > 0) aux.pop()!()
    ws.close()
    await server.stop()
    await rm(dir, { recursive: true, force: true })
  })

  test('successful call resolves with the result', async () => {
    const r = await rpc.call(METHOD.Join, { roomId: 'main', name: 'A', description: '' })
    expect(r).toEqual({ joinedAt: 1_700_000_000_000 })
  })

  test('error response rejects with RpcError carrying the typed code', async () => {
    let thrown: unknown
    try {
      await rpc.call(METHOD.Speak, { text: 'hi' })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(RpcError)
    expect(((thrown as RpcError).data as { code?: string }).code).toBe('NOT_JOINED')
  })

  test('server-pushed batch notification fires the handler', async () => {
    await rpc.call(METHOD.Join, { roomId: 'main', name: 'A', description: '' })

    const conn2 = await connectToBroker({
      stateDir: dir,
      port: server.port,
      spawn: () => { throw new Error('spawn should not run in this test') },
    })
    aux.push(() => conn2.ws.close())
    const rpc2 = new RpcClient({ ws: conn2.ws, onNotification: () => {} })
    await rpc2.call(METHOD.Join, { roomId: 'main', name: 'B', description: '' })
    await rpc2.call(METHOD.Speak, { text: '@A heads up' })

    await new Promise(r => setTimeout(r, 50))
    expect(received).toHaveLength(1)
    expect(received[0]!.method).toBe(METHOD.RoomBatch)
    const params = received[0]!.params as { roomId: string; messages: Array<{ from: string; text: string }> }
    expect(params.roomId).toBe('main')
    expect(params.messages[0]!.from).toBe('B')
    expect(params.messages[0]!.text).toBe('@A heads up')
  })

  test('parallel calls resolve independently with the correct response paired to each id', async () => {
    await rpc.call(METHOD.Join, { roomId: 'main', name: 'A', description: '' })
    const [members, history] = await Promise.all([
      rpc.call(METHOD.ListMembers, {}),
      rpc.call(METHOD.ReadHistory, {}),
    ])
    expect((members as { members: unknown[] }).members).toHaveLength(1)
    expect((history as { messages: unknown[] }).messages).toEqual([])
  })
})
