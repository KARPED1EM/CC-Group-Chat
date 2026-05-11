#!/usr/bin/env bun
// Channel server: the per-CC-session MCP server that bridges Claude Code to
// the group-chat broker. Exposes MCP tools (join / leave / speak /
// read_history / list_members) and forwards broker push events into the
// session as `<channel source="cc-group-chat" ...>` events.

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import {
  METHOD,
  getDefaultStateDir,
  type RoomMessage,
  type SpeakResult,
} from '@cc-group-chat/shared'
import { connectToBroker } from './broker-client.ts'
import { RpcClient, RpcError } from './rpc-client.ts'

const PLUGIN_NAME = 'cc-group-chat'
const PLUGIN_VERSION = '0.1.0'

const INSTRUCTIONS = `\
You are a member of a multi-agent group chat called ${PLUGIN_NAME}. Multiple Claude Code sessions can join the same chat and message each other.

Tools:
- \`join\`: register with a name and one-line self-description. Call this before any other group-chat tool.
- \`speak\`: send a message. Use @<name> to direct it at one member (wakes them); @everyone broadcasts to all members; messages without an @ are appended to history without waking anyone.
- \`read_history\`: fetch the backlog without waking anyone.
- \`list_members\`: see the current roster.
- \`leave\`: unregister. Closing this Claude Code session also implicitly leaves.

Channel events arrive as <channel source="${PLUGIN_NAME}" from="..." message_id="...">. You receive an event ONLY when you are addressed (directly @ed, or via @everyone). Other members' chatter does not reach you.

KEEP MESSAGES SHORT. Send one point per message and let the recipient respond before adding the next. Long monolithic messages (~400+ characters) create coordination friction because the recipient has to absorb your entire essay before they can engage, and you cannot pause mid-essay to look something up. Break a complex thought into several \`speak\` calls connected by the natural rhythm of replies. If you need to put a literal \`@name\` in your text without addressing anyone, wrap it in backticks (\`\\\`@name\\\`\`) or escape with a backslash (\`\\\\@name\`).

Sending nothing in response is valid. Do NOT politely acknowledge messages you have no real input on — silence is the correct behaviour when the message is not relevant to you, you have no useful information, or you are busy with the user's own work.\
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
    description: 'Send a message to the group chat. @<name> wakes that member; @everyone broadcasts; messages without any @ are appended to history without waking anyone. Prefer short single-point messages and let the recipient reply before continuing — the recipient has no way to read a partial message.',
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
    description: 'List members currently in the chat.',
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

const conn = await connectToBroker({ stateDir: getDefaultStateDir() })

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
    if (method !== METHOD.RoomEvent) return
    const event = params as RoomMessage
    void mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content: event.text,
        meta: {
          from: event.from,
          message_id: String(event.id),
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
  try {
    const result = await rpc.call(rpcMethod, req.params.arguments ?? {})
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
  // The broker has gone away; future tool calls will fail until the channel
  // server is restarted (which usually means restarting Claude Code).
  console.error('cc-group-chat: broker connection closed')
})

await mcp.connect(new StdioServerTransport())

/**
 * Trim the broker response shown to the caller. The `speak` call returns a
 * full `SpeakResult` whose `message.text` is the speaker's own text echoed
 * back — keeping it in the tool result wastes tokens since the caller already
 * has it. Other calls return concise data that we pretty-print as-is.
 */
function formatToolResult(toolName: string, result: unknown): string {
  if (toolName === 'speak') {
    const r = result as SpeakResult
    return JSON.stringify({
      id: r.message.id,
      delivered: r.delivered,
      throttled: r.throttled,
      everyoneThrottled: r.everyoneThrottled,
    })
  }
  return JSON.stringify(result, null, 2)
}
