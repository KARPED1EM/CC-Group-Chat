# Backlog

Past releases (design rationale), lessons learned in production, and the open backlog. See [`../../CHANGELOG.md`](../../CHANGELOG.md) for the chronological version history.

## Past releases — design rationale

The sections below document *why* each shipped feature looks the way it does. The chronology lives in [`CHANGELOG.md`](../../CHANGELOG.md); this file is the long-form design memory.

### Single-instance broker via port-bind contention — shipped in v0.2

Replaces an earlier file-lock plus `~/.cc-group-chat/broker.json` discovery with a port-bind race.

- Broker derives its TCP port from the local username: `47000 + (sha256(username) % 1000)`.
- Broker tries `Bun.serve({ port: derivedPort })`. Success: it is the broker. `EADDRINUSE`: another broker is alive — exit with code `0`, the spawner will retry connect.
- Channel client connects directly to the derived port. On failure, it spawns a daemon and short-polls.
- State file `~/.cc-group-chat/broker.json` is demoted to observation metadata (pid, startedAt, version, log path). It is not on the critical path; stale is fine.
- Rationale: the kernel's bind/listen primitive is already atomic, crash-safe, and OS-portable. File locks reinvent it on top.

### Cross-user isolation — shipped in v0.2

Multi-user shared hosts (Linux servers, classroom machines) must not cross-talk.

- Per-user port derivation (above) gives kernel-level isolation between uids.
- Broker only binds `127.0.0.1`, never `0.0.0.0`.
- On first run, broker writes a 32-byte random token to `~/.cc-group-chat/auth-token` (mode `0600`). The channel-side client reads it and includes it in the `join` RPC. The broker rejects joins whose token does not match the file it generated. Defense in depth.

### Multi-room with capability-as-permission — shipped in v0.2

A single shared room is too coarse. Different work streams need isolation.

- Broker holds a `RoomManager`; each room is a separate `Room` instance with its own membership, history, and storm guard.
- `join` becomes `join(room_id, name, description)`. `room_id` is lazy-created if absent.
- **Enforcement at the channel server tool schema** (not just the broker): the channel server's `join` MCP tool does NOT expose `room_id` as a parameter. The channel server reads `CC_GROUP_CHAT_ROOM` from env and supplies `room_id` itself. The LLM has no knob to override.
- If env is not set, the channel server falls back to `auto-<sha256(realpath(cwd))[0:8]>` so sessions in the same project directory naturally rendezvous.
- `list_rooms` and `create_room` are not in the default tool listing at all. Out-of-scope cross-room discovery is intentionally unbuilt — capability gating beats prompt instructions.
- All existing tools are room-scoped: `speak`, `read_history`, `list_members`, `@everyone` only see the bound room.
- Channel-event `<channel>` tag carries a `room="..."` attribute so agents can disambiguate when reconfigured for multiple environments.

### Room lifecycle — shipped in v0.2

- Rooms are created lazily on first `join` with that id.
- When the last member leaves, the room stays in memory with its history for **7 days** (configurable, see v0.3 below). After that the broker GCs the room.
- A room re-created at the same id after GC starts fresh. Old history is **not** replayed to new members — privacy expectation.

### Engagement state — shipped in v0.2

Resolves the "silence ambiguity" problem (was the agent silent because it did not receive the message, did not care, or is busy?).

- `Member` gains `engagement: 'idle' | 'engaged'`.
- The Room tracks each member's last activity timestamp; `engagement` is computed from `now - lastActivity < engagementWindowMs`.
- The Broker calls `recordActivity` on every member-bound RPC (`speak`, `read_history`, `list_members`, `leave`), so engagement reflects real usage.
- Surfaced via `list_members` only — never pushed. No extra wake events.

### Loosen and make configurable — shipped in v0.3

After v0.2 dogfooded the new architecture, a review pass relaxed limits that were calibrated for the old single-room world. All defaults are now overridable via environment variables on the broker daemon side.

- **Room id resolution**: channel server now also honours `CC_GROUP_CHAT_ROOM_FROM_DIR` (path to derive cwd-hash from). Precedence: `CC_GROUP_CHAT_ROOM` > `CC_GROUP_CHAT_ROOM_FROM_DIR` > `realpath(cwd)` hash.
- **Room hard cap**: default raised from 200 to 1000 messages. Override with `CC_GROUP_CHAT_HARD_CAP`.
- **@everyone cooldown**: default lowered from 5 minutes to 60 seconds. Override with `CC_GROUP_CHAT_EVERYONE_COOLDOWN_MS`.
- **Per-member wake budget**: 10 by default; expose `CC_GROUP_CHAT_WAKE_BUDGET` and `CC_GROUP_CHAT_WAKE_WINDOW_MS` so operators can tune for high-traffic projects.
- **Solo-speaker @everyone**: when the speaker is the only member, the broadcast skips the cooldown entirely (it would reach no audience, so charging the cooldown was a latent bug — a real broadcast a few seconds later would have been wrongly throttled).
- **`stormGuardOptions` in RoomOptions**: lets callers configure storm-guard parameters without pre-building a `StormGuard` instance. Used by the daemon to plumb env vars through the broker → RoomManager → Room chain.

### Smaller fixes shipped in v0.1.x

- `speak` MCP tool no longer echoes the full message text back in its return JSON. Output is `{ id, delivered, throttled, everyoneThrottled }`.
- Mention parser respects code spans and escape characters: text inside backticks (`` `@foo` `` and ``` ```@foo``` ```) and text immediately preceded by `\` (`\@foo`) is not parsed as a mention.
- Channel server `instructions` explicitly guides agents to write short, single-point messages.
- `.mcp.json` uses `${CLAUDE_PLUGIN_ROOT}/bin/channel.js` so the installed plugin works regardless of the user's working directory.

### TIME_WAIT

Not strongly mitigated. The README's troubleshooting section says "If broker reports `EADDRINUSE` immediately after a clean shutdown, wait ~60 seconds and retry." Bun does not currently expose the socket options needed (`SO_REUSEADDR` / `SO_LINGER=0`) for a clean fix.

## Lessons learned

### v0.1.1 — testing-gap: end-to-end was only ever tested inside the plugin repo

The `${CLAUDE_PLUGIN_ROOT}` bug shipped because every dogfooding session up to that point was launched **from inside the plugin's own source repo** (`cwd = <repo>/CC-Group-Chat`). That happened to be a directory where the relative path `./bin/channel.js` resolved correctly, masking the issue. Real users running the marketplace-installed plugin from their own project directories silently got no MCP server at all.

**Manual verification checklist for every release going forward**:

1. Bump `plugin.json` `version`, push, wait for the release workflow to publish.
2. In a Claude Code session, `/plugin marketplace update` and `/plugin update` to pull the new version.
3. **Open a fresh Claude Code window in a directory that is NOT the plugin's source repo** (e.g., an unrelated work project).
4. Confirm the `cc-group-chat` MCP server appears in the session — the system reminder should list its tools.
5. Run `join` then `list_members` round-trip from that unrelated directory.
6. From a second session in the same unrelated directory, verify push/wake works end-to-end.

Until those six steps pass, the release is not really "out".

## Open backlog

Listed roughly in order of expected return on effort.

### Push micro-batching — earmarked for v0.4

Coalesce rapid-fire pushes into a single channel event so the recipient wakes once. The broker side is straightforward (per-recipient 50ms queue, flush as an array on the existing `PushFn`). The hard part is the `<channel>` content format: combining multiple messages into one tag means designing a new shape that agents can parse, plus updating the agent-facing system instructions to teach it. Treat as a small product change, not just a bug-fix.

### `list_members` without join

Surface during dogfooding ("look at the room but don't make me join yet"). Real UX gap, but the implementation forces a choice: either a new RPC path that takes an explicit `room_id`, or a connection-level "bound room without bound member" state. Both are non-trivial protocol changes. Defer until a stronger use case emerges than "peek before commit".

### Description mutation

`description` is set at `join` and immutable thereafter. Members' actual focus drifts during a long session, so the description quickly becomes a lie. An `update_description` tool is easy, but the same data path that introduces a `name` collision (DUPLICATE_NAME) returns nothing useful on description change. Wait for a real user complaint before adding API surface.

### Channel server auto-reconnect

When the broker process dies (Ctrl+C, OS-level kill, crash), each channel server's WebSocket closes and tool calls start failing. Currently the only fix is to restart the Claude Code session. Could detect the close, re-spawn the broker, and reconnect transparently. Risk: a flapping broker could thrash; mitigate with backoff + cap on consecutive retries.

### Per-session channel-event summarization

Long-running sessions accumulate channel events in their context monotonically. After N events, replace older ones with a synthesized "channel summary" turn. This is an LLM-level fix, not a transport fix, and overlaps with whatever long-context strategies Claude Code itself ships.

## UX pain points (2026-05-11 dogfooding)

Captured during a real two-session collaboration that designed v0.2 entirely through the chat itself.

### Protocol-level

| # | Pain | Status |
| - | ---- | ------ |
| 1 | `speak` JSON return echoed full message text — wasted tokens | Fixed in v0.1.x |
| 2 | Mention parser triggered on literal `@name` examples inside text | Fixed in v0.1.x |
| 3 | `speak` is atomic — agents cannot stream partial messages or pause mid-message to look something up | Not fixed. The underlying LLM turn is itself atomic; protocol-level "typing hint" would lie about state that does not exist. Right fix is shorter messages, taught in instructions |
| 4 | No sub-structure references — `message_id` is message-level only | Not fixed. Could add `in_reply_to` later if threading is needed |
| 5 | No multi-room isolation — every session in one global room | Fixed in v0.2 |
| 6 | No engagement signal — silence is ambiguous | Fixed in v0.2 |

### LLM-specific — mitigations only

| # | Pain | Mitigation |
| - | ---- | ---------- |
| 7 | Each channel push is a separate turn — fast back-to-back messages produce N wakes and N context insertions | Push micro-batching (open backlog) will reduce wake count but not context bloat |
| 8 | Channel events are monotonically appended to the agent's context — long sessions degrade attention | No clean fix without protocol-level summarization (open backlog) |
| 9 | The `speak` tool description does not surface "messages without `@` are fire-and-forget and wake no one" — that contract lives only in the server-level instructions block | Could be moved into the tool description directly |

### Light pain — acceptable for now

| # | Pain |
| - | ---- |
| 10 | Identity conflict throws `DUPLICATE_NAME` instead of suggesting `Tester-2` or returning the current roster |
| 11 | Agents have no visibility into room metadata (title, who is listening, retention policy, etc.) |
| 12 | Agents are mutually blind to each other's `read_history` state — may redundantly quote material the recipient already pulled |
