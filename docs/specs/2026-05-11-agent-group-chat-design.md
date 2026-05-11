# CC Group Chat — Design

Status: draft. Approved verbally; subject to revision as spikes land.
Date: 2026-05-11.

## Problem

A user runs multiple Claude Code sessions in parallel, one per concern (auth refactor, reverse engineering, mod authoring, …). Today, getting those sessions to coordinate means the user manually relays context between windows. We want them to talk directly.

The interaction model we are NOT building:

- Synchronous chat room with strict turn-taking
- Forced consensus protocol with votes and termination decree
- "Owner" facilitator agent that adjudicates

The interaction model we ARE building, in one sentence:

> A persistent room each session can join with a name and a short self-description. Messages with `@someone` wake that session; messages without `@` are silently appended to history. Sessions may speak, ignore, leave, or read history at any time. There is no formal end.

This treats the room as shared infrastructure — a group chat for agents that behaves like a group chat for humans. Real-human chat etiquette gives us the protocol for free; we do not need to invent one.

## Constraints and guarantees

- **Claude Code v2.1.80+**, Anthropic auth only. Channels are not available on Bedrock / Vertex / Foundry.
- **Research preview**: custom channels currently require `--dangerously-load-development-channels`. Future state: submit to the official marketplace for security review, then one-line install for end users.
- **Per-session subprocess**: Claude Code spawns one MCP server per session over stdio. Multiple sessions cannot share an MCP server process. State must live elsewhere.

## Architecture

```
┌─────────────┐  stdio   ┌──────────────────┐
│  CC session │ ──────── │ channel server   │ ──┐
│  A          │          │ (per-session)    │   │
└─────────────┘          └──────────────────┘   │
                                                │  local IPC (Unix socket
┌─────────────┐  stdio   ┌──────────────────┐   │   on POSIX, named pipe
│  CC session │ ──────── │ channel server   │ ──┤   on Windows)
│  B          │          │ (per-session)    │   │
└─────────────┘          └──────────────────┘   │
                                                ▼
                                  ┌──────────────────────────┐
                                  │ broker daemon            │
                                  │ (single shared process)  │
                                  │  - membership registry   │
                                  │  - message history       │
                                  │  - @ routing             │
                                  │  - storm guards          │
                                  │  - history persistence   │
                                  └──────────────────────────┘
```

Three components, three packages:

- **`packages/shared`** — Protocol types and tiny pure helpers shared by both runtimes.
- **`packages/broker`** — The daemon. One process per host, auto-spawned by the first channel server that finds none running. Holds room state in memory; snapshots to disk for crash recovery and post-mortem reading.
- **`packages/channel`** — The Claude Code plugin. A bun script spawned by CC over stdio. Translates between MCP tool calls / channel notifications and the broker's IPC protocol.

### Channel server (per session)

For each session, the channel server:

1. Declares `capabilities.experimental['claude/channel']` so CC registers the notification listener.
2. Exposes MCP tools: `join`, `speak`, `leave`, `read_history`, `list_members`.
3. Connects to the broker on startup. Auto-spawns the broker if not running.
4. Forwards inbound MCP tool calls to the broker.
5. Receives broker push events and emits them to CC as `notifications/claude/channel`.

### Broker daemon

Single process per host. Listens on a local IPC endpoint. Responsibilities:

- Membership registry: `name → { description, session_id, connected_at }`.
- Message log per room: append-only, monotonically numbered.
- `@` parsing and routing: messages with `@target` push to that target's channel server; messages without push to no one (they only land in history).
- Storm guards:
  - Per-member wake budget: ≤10 wakes per 5 minutes. Excess wakes are reported back to the speaker in `SpeakResult.throttled` so the agent knows the target did not receive the message; nothing is queued.
  - Per-room hard cap: ≤200 messages; further sends throw `ROOM_FULL`.
  - `@everyone` rate limit: ≤1 trigger per 5 minutes. A throttled broadcast is reported in `SpeakResult.everyoneThrottled`; per-name mentions in the same message still deliver as usual.
- Persistence: append each message to `~/.cc-group-chat/rooms/<room-id>.jsonl`. Reload on restart.

The broker has no view of room semantics beyond routing — it does not detect consensus, terminate conversations, or judge content.

## Protocol

### MCP tools exposed to Claude

| Tool            | Args                                                  | Returns       | Effect |
| --------------- | ----------------------------------------------------- | ------------- | ------ |
| `join`          | `name: string, description: string`                   | `{ room_id }` | Registers this session. Names must be unique per room. |
| `speak`         | `text: string`                                        | `{ id }`      | Appends a message to room history. `@name` mentions wake the matched member. |
| `leave`         | `()`                                                  | `{}`          | Unregisters this session. Idempotent. |
| `read_history`  | `since_id?: number, limit?: number`                   | `{ messages }`| Pull-mode access for catching up without being woken. |
| `list_members`  | `()`                                                  | `{ members }` | Roster of current members and their descriptions. |

### Inbound channel events (broker → channel → Claude)

When a message arrives addressed to a member, the broker pushes to that channel server, which emits to Claude as:

```
<channel source="cc-group-chat" room_id="..." message_id="42" from="ModDev">
@Decompiler can you give me the field layout for PlayerController?
</channel>
```

Claude reads the tag, decides whether to respond, and if so calls `speak`. Silence is a valid response.

### Broker IPC (channel ↔ broker)

JSON-RPC over local stream. Methods mirror the MCP tools plus a `subscribe` for push delivery. Detailed in `packages/shared/src/protocol.ts` once written.

## Lifecycle

- **Join**: human user instructs each CC session "join the group chat as `<name>` doing `<description>`". The session calls `join`. Nothing else happens.
- **Discuss**: human user prompts one session to start the discussion. That session calls `speak` with `@`s. Wakes propagate. Sessions reply, ignore, or pull history as they like.
- **Idle**: when no `@` traffic and no one speaks, the room is silent. The state persists.
- **Leave**: a session calls `leave` whenever it wants out. Or the human user broadcasts "leave the chat" to it. Or it just stops; the broker drops it after IPC disconnect.

There is no "end of meeting" — only silence and individual departures.

## Anti-patterns we explicitly reject

- **Structured stance fields** (`agree | disagree | abstain`) on every message — adds noise to non-consensus scenarios (information exchange, status sync).
- **LLM-driven speaker selection** — AutoGen's `auto` mode is famously fragile (returns `TERMINATE` as a name, picks empty names, doubles LLM cost). Speaker selection is implicit in `@` mentions; no selector logic.
- **LLM-judged consensus detection** — sycophancy makes self-reported consensus unreliable. We do not detect it at all.
- **Fixed turn order** — irrelevant once routing is `@`-driven.
- **Private chats** — the whole point is shared visibility. Explicitly out of scope.

## Out of scope for v0

- Cross-host operation (room is local to one machine).
- Authentication of who can join (any local CC session with the plugin can join any room).
- Encryption of room contents at rest.
- Rich content (file attachments, code blocks beyond plain text).
- Multiple rooms per host (one well-known room id for v0).

These are deliberate cuts. Add them only when there is a real user need.

## Distribution

- v0: distributed as a private plugin in our own marketplace. End users install with two commands and launch CC with `--dangerously-load-development-channels`.
- v1: submitted to `claude-plugins-official` for security review. After approval, one-line install: `/plugin install cc-group-chat@claude-plugins-official` and launch with `--channels plugin:cc-group-chat@claude-plugins-official`.

## Spike plan

Before committing to the broker / channel split, verify the foundation:

1. **Smoke spike** (this commit): a single-file one-way channel echo server at `packages/channel/src/echo.ts`. Prove that a `curl POST` from outside wakes an idle CC session.
2. **Broker test bench**: TDD the broker state machine (membership, `@` routing, storm guards) without any CC integration.
3. **End-to-end**: two CC sessions, real plugin manifest, real broker, scripted scenario.

If the smoke spike does not wake the session, all of the above is moot and we revisit the WebSocket-bus fallback.
