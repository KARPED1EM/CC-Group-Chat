import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { JSON_RPC_VERSION, METHOD, RPC_ERROR_CODES } from '@cc-group-chat/shared'
import { Broker } from '../src/broker.ts'
import { startWsServer, type RunningWsServer } from '../src/ws-server.ts'

interface RpcReply { jsonrpc: string; id?: number | string | null; result?: unknown; error?: { code: number; message: string; data?: unknown }; method?: string; params?: unknown }

async function open(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url)
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true })
    ws.addEventListener('error', () => reject(new Error('failed to open ws')), { once: true })
  })
  return ws
}

function next(ws: WebSocket): Promise<RpcReply> {
  return new Promise((resolve, reject) => {
    const onMessage = (e: MessageEvent): void => {
      cleanup()
      const data = typeof e.data === 'string' ? e.data : (e.data as Buffer).toString('utf8')
      resolve(JSON.parse(data) as RpcReply)
    }
    const onError = (): void => { cleanup(); reject(new Error('ws error before message')) }
    const cleanup = (): void => {
      ws.removeEventListener('message', onMessage)
      ws.removeEventListener('error', onError)
    }
    ws.addEventListener('message', onMessage)
    ws.addEventListener('error', onError)
  })
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

describe('startWsServer', () => {
  let server: RunningWsServer
  let broker: Broker

  beforeEach(() => {
    broker = new Broker({ room: { now: () => 1_700_000_000_000 }, pushBatchMs: 0 })
    server = startWsServer(broker)
  })

  afterEach(async () => {
    await server.stop()
  })

  test('serves an HTTP banner on the same origin', async () => {
    const res = await fetch(`http://${server.hostname}:${server.port}/`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('cc-group-chat')
  })

  test('completes a join round-trip', async () => {
    const ws = await open(server.url)
    ws.send(JSON.stringify({
      jsonrpc: JSON_RPC_VERSION,
      id: 1,
      method: METHOD.Join,
      params: { roomId: 'main', name: 'A', description: 'tester' },
    }))
    const reply = await next(ws)
    expect(reply.id).toBe(1)
    expect((reply.result as { joinedAt: number }).joinedAt).toBe(1_700_000_000_000)
    ws.close()
  })

  test('pushes room_batch to mentioned member', async () => {
    const a = await open(server.url)
    const b = await open(server.url)

    a.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'join', params: { roomId: 'main', name: 'A', description: '' } }))
    await next(a)

    b.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'join', params: { roomId: 'main', name: 'B', description: '' } }))
    await next(b)

    const pushed = next(b)
    a.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'speak', params: { text: '@B come here' } }))

    await next(a)  // speak's own reply
    const event = await pushed
    expect(event.method).toBe(METHOD.RoomBatch)
    const params = event.params as { roomId: string; messages: Array<{ from: string; text: string }> }
    expect(params.roomId).toBe('main')
    expect(params.messages).toHaveLength(1)
    expect(params.messages[0]!.from).toBe('A')
    expect(params.messages[0]!.text).toBe('@B come here')
    expect(event.id).toBeUndefined()

    a.close(); b.close()
  })

  test('disconnect implicitly leaves', async () => {
    const a = await open(server.url)
    a.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'join', params: { roomId: 'main', name: 'A', description: '' } }))
    await next(a)

    const b = await open(server.url)
    b.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'join', params: { roomId: 'main', name: 'B', description: '' } }))
    await next(b)

    a.close()
    await sleep(50)

    b.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'list_members', params: {} }))
    const list = await next(b)
    expect((list.result as { members: Array<{ name: string }> }).members.map(m => m.name)).toEqual(['B'])

    b.close()
  })

  test('returns InvalidRequest for a malformed envelope', async () => {
    const ws = await open(server.url)
    ws.send('{}')
    const reply = await next(ws)
    expect(reply.error?.code).toBe(RPC_ERROR_CODES.InvalidRequest)
    ws.close()
  })

  test('maps a ChatError to ChatError code with data.code', async () => {
    const ws = await open(server.url)
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'speak', params: { text: 'hi' } }))
    const reply = await next(ws)
    expect(reply.error?.code).toBe(RPC_ERROR_CODES.ChatError)
    expect((reply.error?.data as { code: string }).code).toBe('NOT_JOINED')
    ws.close()
  })
})
