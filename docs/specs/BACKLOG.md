# Backlog

Tracks past releases (design rationale), lessons learned, and open work.

## Past releases

### v0.2.0 — sender-side rate limit + push batching + new protocol

The previous rate limiter measured per-recipient wakes and silently dropped messages when an orchestrator was being answered by many helpers in quick succession. Dogfooding in a real four-agent project surfaced this: the orchestrator's wake budget filled with legitimate answers, the limiter throttled subsequent answers, and the orchestrator never knew. Conversation died with neither side aware.

**Architecture fix:**

- Rate limit moves from receiver to sender. A sender that emits more than 30 messages in 60 seconds is rate-limited; receivers are uncapped. This separates "this agent is in a loop" (real signal, sender-side) from "this agent is popular" (false positive, receiver-side). Loops are dropped fast; popular orchestrators never trip.
- `SpeakResult` becomes a discriminated union: `{ ok: true, message, delivered }` or `{ ok: false, reason: 'rate_limited' }`. Rate-limited messages are NOT stored in history and NOT pushed — the sender sees `ok: false` immediately and backs off. No silent drops.
- Push micro-batching at the broker. Multiple messages to the same recipient within a 50ms window coalesce into a single push. An orchestrator that gets four answers in two seconds wakes once with all four.
- Wire protocol: `METHOD.RoomEvent` (single message) replaced by `METHOD.RoomBatch` (`{ roomId, messages: RoomMessage[] }`). Always a batch, even of size one.
- Channel event format: single-line-per-message `[#<id> <from>] <text>`, separated by blank lines. The outer `<channel>` tag carries `count="N"`.
- System instructions rewritten. The previous "silence is OK" line was over-applied: agents responded to every wake with empty acknowledgments and treated themselves as "done" after their first round of answers. The new wording forbids zero-information `speak` calls, frames a wake as "an invitation, not a question", and drops the "session done" announcement pattern.

**Deleted:**

- The whole `StormGuard` class.
- Per-recipient wake budget tracking.
- `@everyone` cooldown — `@everyone` is now just a speak that delivers to multiple recipients with no special handling.
- `everyoneThrottled` field on `SpeakResult`.
- Solo-speaker @everyone cooldown skip (no longer needed; no cooldown).
- `stormGuardOptions` in `RoomOptions`.
- Env vars: `CC_GROUP_CHAT_EVERYONE_COOLDOWN_MS`, `CC_GROUP_CHAT_WAKE_BUDGET`, `CC_GROUP_CHAT_WAKE_WINDOW_MS`.

**Added:**

- `SenderRateLimiter` class with one knob (max per window) and one helper (`tryRecord`).
- Env vars: `CC_GROUP_CHAT_RATE_LIMIT_MAX`, `CC_GROUP_CHAT_RATE_LIMIT_WINDOW_MS`, `CC_GROUP_CHAT_PUSH_BATCH_MS`.
- New tests: `rate-limiter.test.ts`, rewritten `broker.test.ts` covering rate-limit semantics and batching behaviour (sync + async paths).

No backward compatibility. This is a clean break from v0.1.x.

### v0.1.0 → v0.1.2 — initial public release

- **Single-instance discovery via port-bind contention.** Broker derives its TCP port from the local username (`47000 + sha256(username) % 1000`). `Bun.serve` succeeds → it is the broker; `EADDRINUSE` → it exits 0 and the spawner reconnects. Kernel-level atomicity, no file locks.
- **Cross-user isolation.** Per-user port derivation + bind to `127.0.0.1` + per-user 32-byte random auth token at `~/.cc-group-chat/auth-token` (mode `0600`). Different shell users on a shared host cannot cross-talk.
- **Multi-room with capability-as-permission.** Room id comes from the launching shell (`CC_GROUP_CHAT_ROOM`, then `CC_GROUP_CHAT_ROOM_FROM_DIR`, then `realpath(cwd)` hash). Agents have no `list_rooms`, no `create_room`, no `room_id` parameter on `join` — there is no knob for them to switch rooms. The enforcement lives at the channel server's MCP tool schema, not just at the broker; the LLM has no way to attempt the switch.
- **Room lifecycle.** Lazy creation on first `join`. Empty rooms kept for seven days then garbage-collected. A re-created room at the same id after GC starts with empty history (privacy).
- **Engagement state.** `Member.engagement` is computed (not stored): `engaged` if the member has invoked any tool within the last 60 seconds, `idle` otherwise. Surfaced via `list_members` only; never pushed.
- **`${CLAUDE_PLUGIN_ROOT}` in `.mcp.json`** (v0.1.1) so the installed plugin works regardless of the user's cwd.
- **Documentation polish** (v0.1.2): CHANGELOG started, badges in README, BACKLOG restructured into past releases / lessons / open backlog.

### TIME_WAIT

Not strongly mitigated. The README's troubleshooting section says "If broker reports `EADDRINUSE` immediately after a clean shutdown, wait ~60 seconds and retry." Bun does not currently expose the socket options needed (`SO_REUSEADDR` / `SO_LINGER=0`) for a clean fix. Acceptable: broker is a long-lived daemon, not a frequently-restarted service.

## Lessons learned

### v0.1.1 — end-to-end was only ever tested inside the plugin repo

The `${CLAUDE_PLUGIN_ROOT}` bug shipped because every dogfooding session up to that point was launched **from inside the plugin's own source repo** (`cwd = <repo>/CC-Group-Chat`). That happened to be a directory where the relative path `./bin/channel.js` resolved correctly, masking the issue. Real users running the marketplace-installed plugin from their own project directories silently got no MCP server at all.

**Manual verification checklist for every release going forward:**

1. Bump `plugin.json` `version`, push, wait for the release workflow to publish.
2. In a Claude Code session, `/plugin marketplace update` and `/plugin update` to pull the new version.
3. **Open a fresh Claude Code window in a directory that is NOT the plugin's source repo** (e.g., an unrelated work project).
4. Confirm the `cc-group-chat` MCP server appears in the session — the system reminder should list its tools.
5. Run `join` then `list_members` round-trip from that unrelated directory.
6. From a second session in the same unrelated directory, verify push/wake works end-to-end.

Until those six steps pass, the release is not really "out".

### v0.2.0 — receiver-side throttling was the wrong axis

The original storm guard counted wakes on the recipient and threw out everything past the cap. The cap was 10 wakes in 5 minutes, calibrated for two agents chatting; in real four-agent synthesis a single helper's three-part answer landed three wakes on the orchestrator and helpers piled on. The orchestrator hit the cap mid-conversation. Helpers' speak calls returned `throttled` but no one read that field. The conversation simply ended.

The fix was to move the limit to the sender. "This sender is in a loop" is a clean signal; "this receiver is busy" is meaningless — popular receivers are the entire point of a coordinator pattern. Once measured on the right axis, both the threshold (30 messages per minute) and the failure mode (sender sees `ok: false` immediately) become obvious.

**General rule:** when a rate limit fires on legitimate use, do not raise the threshold — check whether the limit is measuring the wrong dimension.

## Open backlog

Listed roughly in order of expected return on effort.

### `list_members` without join

Surfaced during dogfooding ("look at the room but don't make me join yet"). Real UX gap, but the implementation forces a choice: either a new RPC path that takes an explicit `room_id`, or a connection-level "bound room without bound member" state. Both are non-trivial protocol changes. Defer until a stronger use case emerges than "peek before commit".

### Description mutation

`description` is set at `join` and immutable thereafter. Members' actual focus drifts during a long session, so the description quickly becomes a lie. An `update_description` tool is straightforward, but no clear user demand yet. Wait for a real complaint before adding API surface.

### Channel server auto-reconnect

When the broker process dies (Ctrl+C, OS-level kill, crash), each channel server's WebSocket closes and tool calls start failing. Currently the only fix is to restart the Claude Code session. Could detect the close, re-spawn the broker, and reconnect transparently. Risk: a flapping broker could thrash; mitigate with backoff + cap on consecutive retries.

### Per-session channel-event summarization

Channel events accumulate monotonically in the agent's context. Long-running sessions degrade attention as old events stay loaded forever. A periodic "channel summary" turn — every N messages, replace the prefix of the channel-event log with a synthesized summary — would let sessions run indefinitely. Hard part: doing it without losing references the agent might still want.

### Identity conflict graceful recovery

`join` with a taken name throws `DUPLICATE_NAME`. The agent could be told the current roster and asked to pick a different name, or the broker could auto-suffix (`Tester-2`). Low-pri until a user complains.
