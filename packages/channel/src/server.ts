#!/usr/bin/env bun
// Channel server: the per-CC-session MCP server that bridges Claude Code to
// the group-chat broker. Exposes MCP tools (join / leave / speak /
// read_history / list_members) and forwards broker room-batch push events
// into the session as `<channel source="cc-group-chat" ...>` events.

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import {
  METHOD,
  type RoomBatch,
  type SpeakResult,
} from '@cc-group-chat/shared'
import { connectToBroker } from './broker-client.ts'
import { resolveRoomId } from './resolve-room.ts'
import { RpcClient, RpcError } from './rpc-client.ts'

const PLUGIN_NAME = 'cc-group-chat'
const PLUGIN_VERSION = '0.2.0'
const ROOM_ID = resolveRoomId()

const INSTRUCTIONS = `\
You are a member of a multi-agent group chat called ${PLUGIN_NAME}. Multiple Claude Code sessions can join the same room and message each other.

Your tools:
- \`join(name, description)\`: register before any other group-chat tool. Pick a stable handle and one-line description of what you are responsible for.
- \`speak(text)\`: post a message. Use \`@<name>\` to wake a specific member; \`@everyone\` to wake everyone in the room; messages without an @ are silently appended to history (no wake).
- \`read_history(sinceId?, limit?)\`: fetch backlog without waking anyone.
- \`list_members()\`: see the current roster, including each member's engagement state.
- \`leave()\`: unregister.

You are bound to room \`${ROOM_ID}\`. The room id is fixed for this Claude Code session by environment variables or a hash of the working directory. You cannot switch rooms.

Inbound messages arrive as a single \`<channel source="${PLUGIN_NAME}" room="..." count="N">\` event. The body contains one or more lines, each formatted:

  [#<id> <from>] <text>

Multiple lines are separated by a blank line. You only ever receive a channel event when you have been addressed (directly via \`@yourname\` or via \`@everyone\`). Other members' chatter does not reach you.

Rules:

1. **No empty acknowledgments.** Do not call \`speak\` with content like "OK", "noted", "等下一步", "Idle." or any other zero-information message. These cost a wake on the other side and deliver nothing. Either respond with substance, or do not call \`speak\` at all.

2. **Short messages, one point each.** Long monolithic messages prevent the recipient from engaging incrementally. Aim for ~100-200 characters per \`speak\`; never more than ~500. Break complex thoughts into several calls.

3. **A wake is an invitation, not a question.** Being woken means someone addressed you. You do not have to respond — only respond if you have something concrete to add. Silence (no \`speak\` call) is the right answer when you have nothing useful. Do not produce a placeholder reply.

4. **Handle rate limiting.** If \`speak\` returns \`{ok: false, reason: "rate_limited"}\`, your message was not stored or pushed. You are sending too fast. Wait at least 60 seconds before retrying, or condense multiple pending points into one call.

5. **If a literal \`@name\` appears in your text without addressing anyone**, wrap it in backticks (\\\`@name\\\`) or escape it (\\@name) so the broker does not parse it as a mention.

6. **The chat is always open.** Do not announce "I am done" or "session idle" — just stop calling tools. If another @ comes in later, treat it as a new request.\
`

const TOOLS = [
  {
    name: 'join',
    description: 'Join the group chat. Must be called before speak / read_history / list_members / leave.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Unique handle. Letters, digits, hyphens or underscores; starts with a letter; up to 64 chars. Members @ you using this name.',
        },
        description: {
          type: 'string',
          description: 'One-line self-description: what module or task you are responsible for. Up to 280 characters.',
        },
      },
      required: ['name', 'description'],
    },
  },
  {
    name: 'speak',
    description: 'Send a message to the group chat. @<name> wakes that member; @everyone broadcasts; messages without any @ are appended to history without waking anyone. Returns { ok: true, id, delivered } on success or { ok: false, reason: "rate_limited" } if you are sending too fast.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
      },
      required: ['text'],
    },
  },
  {
    name: 'leave',
    description: 'Leave the group chat. Idempotent.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'read_history',
    description: 'Fetch the message history without being woken by it.',
    inputSchema: {
      type: 'object',
      properties: {
        sinceId: { type: 'number', description: 'Only return messages with id strictly greater than this. Optional.' },
        limit: { type: 'number', description: 'Maximum number of messages to return. Optional.' },
      },
    },
  },
  {
    name: 'list_members',
    description: 'List members currently in the chat, with their engagement state (idle | engaged).',
    inputSchema: { type: 'object', properties: {} },
  },
] as const

const TOOL_TO_METHOD: Record<string, string> = {
  join: METHOD.Join,
  speak: METHOD.Speak,
  leave: METHOD.Leave,
  read_history: METHOD.ReadHistory,
  list_members: METHOD.ListMembers,
}

const conn = await connectToBroker()

const mcp = new Server(
  { name: PLUGIN_NAME, version: PLUGIN_VERSION },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    instructions: INSTRUCTIONS,
  },
)

const rpc = new RpcClient({
  ws: conn.ws,
  onNotification: (method, params) => {
    if (method !== METHOD.RoomBatch) return
    const batch = params as RoomBatch
    if (batch.messages.length === 0) return
    void mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content: formatBatchContent(batch),
        meta: {
          room: batch.roomId,
          count: String(batch.messages.length),
        },
      },
    })
  },
})

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const rpcMethod = TOOL_TO_METHOD[req.params.name]
  if (rpcMethod === undefined) {
    throw new Error(`Unknown tool: ${req.params.name}`)
  }
  const args = req.params.name === 'join'
    ? { ...(req.params.arguments ?? {}), roomId: ROOM_ID, authToken: conn.authToken }
    : req.params.arguments ?? {}
  try {
    const result = await rpc.call(rpcMethod, args)
    return { content: [{ type: 'text', text: formatToolResult(req.params.name, result) }] }
  } catch (err) {
    if (err instanceof RpcError) {
      const code = (err.data as { code?: string } | undefined)?.code ?? 'RPC_ERROR'
      throw new Error(`${code}: ${err.message}`)
    }
    throw err
  }
})

conn.ws.addEventListener('close', () => {
  console.error('cc-group-chat: broker connection closed')
})

await mcp.connect(new StdioServerTransport())

function formatBatchContent(batch: RoomBatch): string {
  return batch.messages
    .map(m => `[#${m.id} ${m.from}] ${m.text}`)
    .join('\n\n')
}

function formatToolResult(tool: string, result: unknown): string {
  if (tool === 'speak') {
    const r = result as SpeakResult
    if (r.ok) {
      return JSON.stringify({ ok: true, id: r.message.id, delivered: r.delivered })
    }
    return JSON.stringify({ ok: false, reason: r.reason })
  }
  return JSON.stringify(result, null, 2)
}
