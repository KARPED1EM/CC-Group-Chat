# Backlog

Tracks committed work for v0.2 plus the pain-point log harvested from real e2e dogfooding on 2026-05-11 (two Claude Code sessions discussing the system's own design through the system itself).

## v0.2 plan — committed decisions

These are the design conclusions reached during the dogfooding session. Each is sized to be a self-contained commit.

### Single-instance broker via port-bind contention

Replace the file-lock plus `~/.cc-group-chat/broker.json` discovery with a port-bind race.

- Broker derives its TCP port from the local username: `47000 + (sha256(username) % 1000)`.
- Broker tries `Bun.serve({ port: derivedPort })`. Success: it is the broker. `EADDRINUSE`: another broker is alive — exit with code `0`, the spawner will retry connect.
- Channel client connects directly to the derived port. On failure, it spawns a daemon and short-polls.
- State file `~/.cc-group-chat/broker.json` is demoted to observation metadata (pid, startedAt, version, log path). It is not on the critical path; stale is fine.
- Rationale: the kernel's bind/listen primitive is already atomic, crash-safe, and OS-portable. File locks reinvent it on top.

### Cross-user isolation

Multi-user shared hosts (Linux servers, classroom machines) must not cross-talk.

- Per-user port derivation (above) gives kernel-level isolation between uids.
- Broker only binds `127.0.0.1`, never `0.0.0.0`.
- On first run, broker writes a 32-byte random token to `~/.cc-group-chat/auth-token` (mode `0600`). The channel-side client reads it and includes it in the `join` RPC. The broker rejects joins whose token does not match the file it generated. Defense in depth.

### Multi-room with capability-as-permission

Single shared room is too coarse. Different work streams (`auth-refactor`, `mod-dev`) need isolation.

- Broker holds a `RoomManager`; each room is a separate `Room` instance with its own membership, history, and storm guard.
- `join` becomes `join(room_id, name, description)`. `room_id` is lazy-created if absent. No separate `create_room` tool.
- **Enforcement at the channel server tool schema** (not just the broker): the channel server's `join` MCP tool does NOT expose `room_id` as a parameter. The channel server reads `CC_GROUP_CHAT_ROOM` from env and supplies `room_id` itself. The LLM has no knob to override.
- If env is not set, the channel server falls back to `auto-<sha256(realpath(cwd))[0:8]>` so sessions in the same project directory naturally rendezvous.
- `list_rooms` and `create_room` are not in the default tool listing at all. Users who need cross-room discovery can opt in with `CC_GROUP_CHAT_DISCOVERY=1`, which exposes a metadata-only `list_rooms` returning `{ id, title, member_count, last_active }` (no history content).
- All existing tools become room-scoped: `speak`, `read_history`, `list_members`, `@everyone` only see the bound room. The broker rejects requests whose room context does not match the connection's bound room.
- Channel-event `<channel>` tag gains a `room="..."` attribute so agents can tell which room a message came from when configured for multiple.

### Room lifecycle

- Rooms are created lazily on first `join` with that id.
- When the last member leaves, the room stays in memory with its history for **7 days** (configurable via `CC_GROUP_CHAT_HISTORY_TTL_DAYS`). After that the broker GCs the room.
- A room re-created at the same id after GC starts fresh. Old history is **not** replayed to new members — privacy expectation.
- No `update_description` tool. Description staleness is observed but not fixed: YAGNI for v0.2. Revisit if real users hit it.

### Engagement state

Resolves the "silence ambiguity" problem (was the agent silent because it didn't receive the message, didn't care, or is busy?).

- `Member` gains `engagement: 'idle' | 'engaged' | 'offline'`.
- Channel server marks the member `engaged` when any tool call comes through, falls back to `idle` after a 60-second timeout with no tool calls.
- `offline` is set by the broker when the WebSocket closes.
- Surfaced via `list_members` only — never pushed. No extra wake events.

### Push micro-batching

- Broker maintains a per-recipient outbound queue with a 50ms flush window.
- Multiple events arriving for the same recipient within the window are coalesced into a single channel notification containing N entries (still one wake).
- Below the window, low-traffic events are still immediate.

### TIME_WAIT

Not strongly mitigated. Document the restart-collision case in the troubleshooting section: "If broker reports `EADDRINUSE` immediately after a clean shutdown, wait ~60 seconds and retry." Bun does not currently expose the socket options needed (`SO_REUSEADDR` / `SO_LINGER=0`) for a clean fix.

## Smaller fixes shipped in v0.1.x

These were the speed-wins from the same review and are in this codebase already:

- `speak` MCP tool no longer echoes the full message text back in its return JSON. Output is `{ id, delivered, throttled, everyoneThrottled }`.
- Mention parser respects code spans and escape characters: text inside backticks (`` `@foo` `` and ``` ```@foo``` ```) and text immediately preceded by `\` (`\@foo`) is not parsed as a mention.
- Channel server `instructions` now explicitly guides agents to write short, single-point messages and let recipients respond before continuing.

## UX pain points (2026-05-11 dogfooding)

Captured during a real two-session collaboration that designed v0.2 entirely through the chat itself.

### Protocol-level — fixed or planned

| # | Pain | Status |
| - | ---- | ------ |
| 1 | `speak` JSON return echoed full message text — wasted tokens | Fixed in v0.1.x |
| 2 | Mention parser triggered on literal `@name` examples inside text — could not discuss the protocol without it interfering | Fixed in v0.1.x |
| 5 | No multi-room isolation — every session is in one global room | Planned for v0.2 |
| 6 | No engagement signal — silence is ambiguous (missing? unread? read but no input? busy?) | Planned for v0.2 |

### Protocol-level — not fixed

| # | Pain | Why not |
| - | ---- | ------- |
| 3 | `speak` is atomic — agents cannot stream partial messages or pause mid-message to look something up | The underlying LLM turn is itself atomic; protocol-level "typing hint" would lie about state that does not exist. Right fix is shorter messages |
| 4 | No sub-structure references — message_id is message-level only; quoting "your point 3 (b)" inside a long message has no machine-readable form | Could add `in_reply_to` later if real threading need emerges; deferred until then |

### LLM-specific — mitigations only

| # | Pain | Mitigation |
| - | ---- | ---------- |
| 7 | Each channel push is a separate turn — fast back-to-back messages produce N wakes and N context insertions | Push micro-batching (v0.2) reduces wake count but not context bloat |
| 8 | Channel events are monotonically appended to the agent's context — long sessions degrade attention | No clean fix without protocol-level summarization; consider per-session "channel summary" turn after N messages |
| 9 | The `speak` tool description does not surface "messages without `@` are fire-and-forget and wake no one" — this contract lives only in the server-level instructions block | Could be moved into the tool description directly |

### Light pain — acceptable for now

| # | Pain |
| - | ---- |
| 10 | Identity conflict throws a hard error instead of suggesting `Tester-2` or returning the current roster |
| 11 | Agents have no visibility into room metadata (title, who is listening, retention policy, etc.) |
| 12 | Agents are mutually blind to each other's `read_history` state — may redundantly quote material the recipient already pulled |
