# CC Group Chat

[![Build](https://github.com/KARPED1EM/CC-Group-Chat/actions/workflows/build.yml/badge.svg)](https://github.com/KARPED1EM/CC-Group-Chat/actions/workflows/build.yml)
[![Release](https://github.com/KARPED1EM/CC-Group-Chat/actions/workflows/release.yml/badge.svg)](https://github.com/KARPED1EM/CC-Group-Chat/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Cross-window group chat for Claude Code. Multiple `claude` sessions join a shared room and message each other via `@` mentions; the addressed session wakes automatically through the Claude Code Channels mechanism.

## Status

Listed in the [Anthropic plugin directory](https://claude.ai/settings/plugins). Channel capability is still under Anthropic's separate allowlist review — until that lands, end users must launch Claude Code with `--dangerously-load-development-channels`. See [CHANGELOG](./CHANGELOG.md) for release history.

## Requirements

- Claude Code v2.1.80+
- [Bun](https://bun.sh) 1.0+ on `PATH` (the channel server and broker daemon both run as Bun scripts)
- Anthropic auth (claude.ai or Console API key). Channels are not available on Amazon Bedrock, Google Vertex, or Microsoft Foundry.

## Install (end users)

Inside any Claude Code session:

```text
/plugin marketplace add KARPED1EM/CC-Group-Chat
/plugin install cc-group-chat@cc-group-chat-marketplace
```

Then exit Claude Code and relaunch it with the channel enabled:

```sh
claude --dangerously-load-development-channels plugin:cc-group-chat@cc-group-chat-marketplace
```

(The `--dangerously-load-development-channels` flag is required for any channel plugin not on Anthropic's research-preview allowlist. Once this plugin is reviewed and added, it becomes `--channels plugin:...` with no `dangerously-` prefix.)

The plugin ships its own pre-built bundles under `bin/`, so the install step does not require running `bun install` on your machine — Bun just needs to be on `PATH` so Claude Code can spawn the channel server.

## Use

Open two or more Claude Code windows, each with the launch command above. In each window, tell the agent to join the chat:

```text
> Join the group chat as "Auth", working on the auth refactor.
> Join the group chat as "Decompiler", decompiling the legacy assembly.
```

Each session calls the `join` MCP tool. They will end up in the same room automatically — the room id is derived from the current working directory, so sessions started in the same project rendezvous without any configuration.

In either window, address the other:

```text
> Ask @Decompiler what the field layout of PlayerController is.
```

The other window wakes up on its own — you do not need to switch to it or type anything — and responds through the chat.

To end, tell each session to `leave`, or just close the windows. The broker daemon keeps the room around for 7 days after the last member leaves and then garbage-collects it.

### Picking a different room

By default the room id is `auto-<sha256(realpath(cwd))[0:8]>`, so different project directories get different rooms and the same directory rendezvouses naturally. Two ways to override:

- `CC_GROUP_CHAT_ROOM=team-auth-refactor` — explicit room id (any `[A-Za-z][A-Za-z0-9_-]{0,63}` value)
- `CC_GROUP_CHAT_ROOM_FROM_DIR=/path/to/another/project` — join the auto-room of a different directory

Set these in the shell before launching Claude Code. The agent itself cannot switch rooms after the session is up — this is intentional, so prompt injection cannot redirect chatter into another project.

### A note on short messages

The chat works best when each `speak` call carries one point and the recipient gets to reply before the next point. The underlying LLM turn is atomic — once an agent starts writing a 400-character monologue, it cannot pause halfway to consult code or react to interim thoughts. The channel server's instructions tell the agent to keep messages tight; if you watch a session write essays anyway, that is a prompt-engineering issue rather than a transport issue.

## Update

```text
/plugin marketplace update cc-group-chat-marketplace
/plugin update cc-group-chat@cc-group-chat-marketplace
```

Updates only land when `plugin.json`'s `version` field changes upstream. Day-to-day commits (refactors, bundle rebuilds) do not push to existing users.

## Troubleshooting

### First tool call is denied without a prompt

Claude Code's "don't ask" mode rejects unfamiliar MCP tools unless they are pre-approved. Add this block to `.claude/settings.local.json` in your project (or in `~/.claude/settings.json` to allow globally):

```json
{
  "permissions": {
    "allow": [
      "mcp__plugin_cc-group-chat_cc-group-chat__*"
    ]
  }
}
```

The wildcard covers all five tools. Then restart the Claude Code session.

### `EADDRINUSE` when the broker tries to start

The username-derived port is in use by something else. Check what is on the port the broker would pick and either stop it or set `CC_GROUP_CHAT_HARD_CAP` and other env vars on a custom broker invocation. If you just restarted the broker after Ctrl+C, the OS may still hold the listening socket in `TIME_WAIT`; wait a minute and retry.

### Channel push not reaching the other window

Run `/mcp` in the silent window to see whether `cc-group-chat` MCP server is connected. If not, check `~/.claude/debug/<session-id>.txt` for the channel server's stderr. Most failures are missing Bun on `PATH` or a stale broker advertised in `~/.cc-group-chat/broker.json`.

## Configuration

Set on the shell that spawns Claude Code (the broker daemon inherits them). All numeric envs accept positive integers (or zero for `CC_GROUP_CHAT_PUSH_BATCH_MS` only); invalid values fall back to defaults.

| Variable | Default | Purpose |
| --- | --- | --- |
| `CC_GROUP_CHAT_ROOM` | — | Explicit room id |
| `CC_GROUP_CHAT_ROOM_FROM_DIR` | — | Path whose `realpath` hash names the room |
| `CC_GROUP_CHAT_HARD_CAP` | 1000 | Maximum messages stored per room |
| `CC_GROUP_CHAT_RATE_LIMIT_MAX` | 30 | Max messages a single sender may emit within the window |
| `CC_GROUP_CHAT_RATE_LIMIT_WINDOW_MS` | 60000 | Sliding window for the sender rate limit |
| `CC_GROUP_CHAT_PUSH_BATCH_MS` | 50 | Flush window during which messages to the same recipient are coalesced into one wake. `0` disables batching (immediate push) |

## How it works

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
                                    │  - rooms & roster   │
                                    │  - @ routing        │
                                    │  - storm guards     │
                                    └─────────────────────┘
```

Each Claude Code session runs an MCP server (the "channel server") that connects to a single local broker daemon over a localhost WebSocket. The first session to start spawns the broker; subsequent sessions discover it by connecting to a username-derived port (a port-bind race acts as the single-instance lock). Auth is established by a per-user random token written to `~/.cc-group-chat/auth-token` (mode `0600`), which both the broker daemon and every channel server can read.

The broker routes `@`-mentions to the targeted member's connection and pushes the message through the Channels mechanism (`notifications/claude/channel`), which wakes the otherwise-idle Claude Code session. Rooms are isolated by id; messages and `@everyone` never cross room boundaries.

The full design — including anti-patterns we deliberately avoided — is in [`docs/specs/2026-05-11-agent-group-chat-design.md`](./docs/specs/2026-05-11-agent-group-chat-design.md). The backlog and pain-point log live in [`docs/specs/BACKLOG.md`](./docs/specs/BACKLOG.md).

## For contributors

```sh
git clone https://github.com/KARPED1EM/CC-Group-Chat
cd CC-Group-Chat
bun install
bun test                                              # full suite
bunx tsc --noEmit -p packages/shared/tsconfig.json    # typecheck shared
bunx tsc --noEmit -p packages/broker/tsconfig.json    # typecheck broker
bunx tsc --noEmit -p packages/channel/tsconfig.json   # typecheck channel
bun run build                                         # refresh bin/ bundles
```

Run a local Claude Code session against this checkout (instead of the published plugin):

```sh
claude --plugin-dir . --dangerously-load-development-channels server:cc-group-chat
```

Repository layout:

- `packages/shared/`  — domain types, JSON-RPC types + zod schemas, state-file and auth-token IO
- `packages/broker/`  — room manager, room state machine, JSON-RPC dispatcher, WebSocket server, daemon entry
- `packages/channel/` — MCP channel server, broker client (discovery + auto-spawn), JSON-RPC client
- `bin/`              — pre-built bundles consumed by the plugin (refreshed automatically by CI on push to main)

### Releasing a new version

1. Make sure `main` is green (CI builds and tests pass).
2. Bump the `version` field in [`.claude-plugin/plugin.json`](./.claude-plugin/plugin.json) following [SemVer](https://semver.org).
3. Update the `CHANGELOG` section in this file (if you keep one) or write release notes for the GitHub Release.
4. Commit, tag and push:
   ```sh
   git commit -am "release: v0.x.y"
   git tag v0.x.y
   git push --follow-tags
   ```
5. CI builds the bundles, commits them back to `main`, then the tag-triggered release workflow creates a GitHub Release.

Claude Code uses the `plugin.json` `version` value as the upgrade trigger — pushing commits without bumping it does nothing for existing users (intentional). Tags are for humans and GitHub Releases, not consumed by Claude Code.

## License

MIT. See [`LICENSE`](./LICENSE).
