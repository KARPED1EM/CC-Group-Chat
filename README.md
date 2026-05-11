# CC Group Chat

Cross-window group chat for Claude Code. Multiple `claude` sessions join a shared room and message each other via `@` mentions; the addressed session wakes automatically through the Claude Code Channels mechanism.

## Status

Research preview. Custom channel plugins are gated by Anthropic's research-preview allowlist; until this plugin is reviewed and accepted into the official marketplace, end users must launch Claude Code with `--dangerously-load-development-channels`.

## Requirements

- Claude Code v2.1.80+
- [Bun](https://bun.sh) 1.0+
- Anthropic auth (claude.ai or Console API key). Channels are not available on Amazon Bedrock, Google Vertex, or Microsoft Foundry.

## Try it (local development)

```sh
git clone https://github.com/KARPED1EM/CC-Group-Chat
cd CC-Group-Chat
bun install
```

Open two terminals. In each, start Claude Code with this directory loaded as a plugin and the channel enabled:

```sh
claude --plugin-dir . --dangerously-load-development-channels server:cc-group-chat
```

(The first time it runs, the channel server auto-spawns a broker daemon in the background; the second window connects to the same broker.)

In each session, tell the agent to join the chat:

```
> Join the group chat as "Auth", working on the auth refactor.
```

```
> Join the group chat as "Decompiler", decompiling the legacy assembly.
```

Each session calls the `join` MCP tool.

In either window, address the other:

```
> Ask @Decompiler what the field layout of PlayerController is.
```

The other window wakes up on its own — you do not need to switch to it or type anything — and responds through the chat.

To end, tell each session to `leave`, or just close the windows.

## What the plugin actually does

```
┌────────────────┐  stdio   ┌──────────────────┐
│ claude (CC) #A │ ──────── │ channel server A │ ─┐
└────────────────┘          └──────────────────┘  │ localhost WS
                                                  │
┌────────────────┐  stdio   ┌──────────────────┐  │
│ claude (CC) #B │ ──────── │ channel server B │ ─┤
└────────────────┘          └──────────────────┘  │
                                                  ▼
                                    ┌─────────────────────┐
                                    │ broker daemon       │
                                    │ (auto-spawned)      │
                                    │  - room state       │
                                    │  - @ routing        │
                                    │  - storm guards     │
                                    └─────────────────────┘
```

Each Claude Code session runs an MCP server (the "channel server") that connects to a single local broker daemon over WebSocket. The broker holds the chat state and routes `@`-mentions to the targeted session, which wakes via the Channels mechanism (`mcp.notification("notifications/claude/channel", ...)`).

The full design — including the `@`-routing rules, storm-guard rate limits, and anti-patterns we deliberately avoided — is in [`docs/specs/2026-05-11-agent-group-chat-design.md`](./docs/specs/2026-05-11-agent-group-chat-design.md).

## Distribution

Once this plugin is reviewed and accepted by Anthropic, end users will install it like any other plugin:

```
/plugin marketplace add KARPED1EM/CC-Group-Chat
/plugin install cc-group-chat@cc-group-chat-marketplace
claude --channels plugin:cc-group-chat@cc-group-chat-marketplace
```

Until then, the dev-flag command in the [Try it](#try-it-local-development) section is the path. Anyone with this repo cloned and Bun installed can run it.

## Developing on this code

```sh
bun install
bun test         # full suite across shared / broker / channel
bunx tsc --noEmit -p packages/broker/tsconfig.json   # typecheck broker
bunx tsc --noEmit -p packages/channel/tsconfig.json  # typecheck channel
bunx tsc --noEmit -p packages/shared/tsconfig.json   # typecheck shared
```

Repository layout:

- `packages/shared/`  — domain types, JSON-RPC types + zod schemas, state-file IO
- `packages/broker/`  — room state machine, JSON-RPC dispatcher, WebSocket server, daemon entry
- `packages/channel/` — MCP channel server, broker-client (discovery + auto-spawn), RPC client

## License

MIT. See [`LICENSE`](./LICENSE).
