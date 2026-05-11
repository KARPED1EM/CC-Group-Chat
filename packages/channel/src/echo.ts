#!/usr/bin/env bun
// Smoke spike: a one-way Claude Code channel that forwards anything
// POSTed to localhost:8787 into the running Claude Code session.
// Used solely to verify the channel wake mechanism on this host.

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const PORT = 8787

const mcp = new Server(
  { name: 'echo', version: '0.0.0' },
  {
    capabilities: { experimental: { 'claude/channel': {} } },
    instructions:
      'Events arrive as <channel source="echo" ...>. They are one-way smoke tests ' +
      'for the channel wake mechanism — read the content and acknowledge receipt ' +
      'in plain text, then stop. No tools to call.',
  },
)

await mcp.connect(new StdioServerTransport())

Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  async fetch(req) {
    if (req.method !== 'POST') {
      return new Response(
        `echo channel up on 127.0.0.1:${PORT}\nPOST any body to push it into Claude.\n`,
        { status: 200, headers: { 'Content-Type': 'text/plain' } },
      )
    }
    const body = await req.text()
    await mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content: body,
        meta: { received_at: new Date().toISOString() },
      },
    })
    return new Response('pushed\n', { headers: { 'Content-Type': 'text/plain' } })
  },
})
