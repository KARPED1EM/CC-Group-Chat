import type { ServerWebSocket } from 'bun'
import { Broker, type ConnectionHandle } from './broker.ts'
import { dispatch, formatRoomEventNotification } from './dispatcher.ts'

export interface WsServerOptions {
  readonly hostname?: string
  /** Defaults to `0` (the OS picks an unused port). */
  readonly port?: number
}

export interface RunningWsServer {
  readonly port: number
  readonly hostname: string
  readonly url: string
  stop(): Promise<void>
}

interface WsData {
  handle: ConnectionHandle | undefined
}

/**
 * Start a localhost WebSocket server that exposes `broker` to clients via
 * JSON-RPC 2.0. Each accepted WebSocket maps to one `Broker` connection.
 */
export function startWsServer(broker: Broker, opts: WsServerOptions = {}): RunningWsServer {
  const hostname = opts.hostname ?? '127.0.0.1'
  const requestedPort = opts.port ?? 0

  const server = Bun.serve<WsData>({
    hostname,
    port: requestedPort,
    fetch(req, srv) {
      if (srv.upgrade(req, { data: { handle: undefined } })) return
      return new Response('cc-group-chat broker', {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      })
    },
    websocket: {
      open(ws: ServerWebSocket<WsData>) {
        ws.data.handle = broker.connect((event) => {
          ws.send(formatRoomEventNotification(event))
        })
      },
      message(ws: ServerWebSocket<WsData>, msg: string | Buffer) {
        if (ws.data.handle === undefined) return
        const raw = typeof msg === 'string' ? msg : msg.toString('utf8')
        const response = dispatch(broker, ws.data.handle, raw)
        if (response !== null) ws.send(response)
      },
      close(ws: ServerWebSocket<WsData>) {
        if (ws.data.handle !== undefined) broker.disconnect(ws.data.handle)
      },
    },
  })

  const port = server.port
  if (port === undefined) {
    throw new Error('Bun.serve did not bind a port (unsupported unix-socket mode?)')
  }
  return {
    port,
    hostname,
    url: `ws://${hostname}:${port}`,
    async stop() {
      await server.stop(true)
    },
  }
}
