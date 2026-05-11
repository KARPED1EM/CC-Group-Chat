// JSON-RPC 2.0 client over an open WebSocket. Pairs request IDs to response
// promises and routes server-pushed notifications to a handler.

import { JSON_RPC_VERSION, type JsonRpcErrorBody } from '@cc-group-chat/shared'

export type NotificationHandler = (method: string, params: unknown) => void

export interface RpcClientOptions {
  readonly ws: WebSocket
  readonly onNotification: NotificationHandler
}

export class RpcError extends Error {
  readonly code: number
  readonly data: unknown
  constructor(body: JsonRpcErrorBody) {
    super(body.message)
    this.name = 'RpcError'
    this.code = body.code
    this.data = body.data
  }
}

interface PendingCall {
  resolve(result: unknown): void
  reject(error: Error): void
}

export class RpcClient {
  readonly #ws: WebSocket
  readonly #onNotification: NotificationHandler
  readonly #pending = new Map<number, PendingCall>()
  #nextId = 1

  constructor(opts: RpcClientOptions) {
    this.#ws = opts.ws
    this.#onNotification = opts.onNotification
    this.#ws.addEventListener('message', this.#onMessage)
  }

  call(method: string, params: unknown): Promise<unknown> {
    const id = this.#nextId++
    return new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      this.#ws.send(JSON.stringify({ jsonrpc: JSON_RPC_VERSION, id, method, params }))
    })
  }

  readonly #onMessage = (event: MessageEvent): void => {
    const raw = typeof event.data === 'string'
      ? event.data
      : (event.data as Buffer).toString('utf8')
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return
    }
    if (typeof parsed !== 'object' || parsed === null) return
    const obj = parsed as Record<string, unknown>

    if (typeof obj.id === 'number') {
      const pending = this.#pending.get(obj.id)
      if (!pending) return
      this.#pending.delete(obj.id)
      if ('error' in obj) {
        pending.reject(new RpcError(obj.error as JsonRpcErrorBody))
      } else if ('result' in obj) {
        pending.resolve(obj.result)
      } else {
        pending.reject(new Error('Malformed JSON-RPC response: no result or error'))
      }
      return
    }

    if (typeof obj.method === 'string' && !('id' in obj)) {
      this.#onNotification(obj.method, obj.params)
    }
  }
}
