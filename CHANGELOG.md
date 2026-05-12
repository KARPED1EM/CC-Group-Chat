# Changelog

All notable changes to this project will be documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-05-12

Architectural rewrite around what the throttle is actually protecting against. **Breaking. No backward compatibility.**

### The motivating bug

A four-agent orchestration in a real project hit the per-recipient wake budget. Helpers sent multi-part answers in sequence. Each answer cost a wake on the orchestrator. After ten wakes within five minutes the broker silently dropped the rest. Neither side knew. The conversation died.

### Root cause

The storm guard measured wakes on the **receiver**. The metric correlated with "this agent has been involved in a lot of coordination", which is the wrong thing to flag. The thing to flag is "this **sender** is in a tight loop". Receivers should be free to be popular.

### Replaced

- **Storm guard deleted.** Per-recipient wake budget and `@everyone` cooldown are gone. The whole `StormGuard` class is gone.
- **Sender-side rate limiter added** (`SenderRateLimiter`): default 30 messages per 60 seconds per sender. Loop-y senders fail fast; healthy senders never notice.
- **Push micro-batching** added at the broker: messages destined for the same recipient within a 50ms window are coalesced into one push. Orchestrators receiving N quick answers wake once.

### Protocol changes

- `METHOD.RoomEvent` → `METHOD.RoomBatch`. The notification carries `{ roomId, messages: RoomMessage[] }` — always a batch, even when N = 1.
- `SpeakResult` is now a discriminated union: `{ ok: true, message, delivered }` on success, or `{ ok: false, reason: 'rate_limited' }` when the sender hit its limit. Rate-limited messages are NOT stored in history and NOT pushed. The sender knows immediately and can back off.
- `everyoneThrottled` field deleted from `SpeakResult`. `@everyone` is now just a speak that delivers to multiple recipients; no special cooldown.
- Channel event content format: single line per message `[#<id> <from>] <text>`, multiple separated by a blank line. The outer `<channel>` tag carries `count="N"` instead of per-message `from` / `message_id` attributes.

### Configuration

Replaces the v0.3.x storm-guard envs.

- `CC_GROUP_CHAT_RATE_LIMIT_MAX` (new, default 30) — sender quota
- `CC_GROUP_CHAT_RATE_LIMIT_WINDOW_MS` (new, default 60000) — sender window
- `CC_GROUP_CHAT_PUSH_BATCH_MS` (new, default 50) — batching window, `0` for immediate
- `CC_GROUP_CHAT_EVERYONE_COOLDOWN_MS` (removed)
- `CC_GROUP_CHAT_WAKE_BUDGET` (removed)
- `CC_GROUP_CHAT_WAKE_WINDOW_MS` (removed)

### System instructions rewritten

The previous wording encouraged "silence is OK" so strongly that agents responded to every wake with an empty acknowledgement and treated themselves as "done" after their first round of answers. The new wording:

- Forbids zero-information `speak` calls explicitly (no "OK", no "noted", no "Idle.").
- Frames a wake as "an invitation, not a question" — respond with substance or do not call `speak` at all.
- Teaches the new channel-event format.
- Teaches `speak` rate-limit handling.
- Drops "session done" announcements — the chat stays open until `leave`.

### Tests

175 passing. `storm-guard.test.ts` deleted. New `rate-limiter.test.ts`. `broker.test.ts` rewritten around the new shape: rate-limit semantics, batching window, sync (`pushBatchMs: 0`) and async paths both covered.

## [0.1.2] — 2026-05-12

### Added
- Build and License badges in `README.md`.
- This `CHANGELOG.md`.
- BACKLOG section capturing the v0.1.1 testing-gap lesson and the manual verification checklist for future releases.

### Changed
- README "Status" notes that the plugin is now listed in the Anthropic plugin directory. Channel capability is still gated on Anthropic's separate allowlist review, so `--dangerously-load-development-channels` is still required for now.

## [0.1.1] — 2026-05-11

### Fixed
- `.mcp.json` now uses `${CLAUDE_PLUGIN_ROOT}/bin/channel.js` instead of `./bin/channel.js`. Sessions installed from the marketplace silently failed to spawn the channel server when their working directory differed from the plugin's install directory, because the relative path resolved against the user's cwd rather than the plugin root.

## [0.1.0] — 2026-05-11

### Added
- Initial public release.
- Port-bind broker discovery with username-derived port and per-user auth token (`~/.cc-group-chat/auth-token`, mode `0600`).
- Multi-room with capability-as-permission. Agents cannot list, create, or switch rooms; only the launching shell decides the room (via `CC_GROUP_CHAT_ROOM`, `CC_GROUP_CHAT_ROOM_FROM_DIR`, or cwd hash).
- Engagement state (`idle` / `engaged`) on `list_members`.
- Pre-built channel-server and broker-daemon bundles shipped in `bin/` so end users do not need to run `bun install` after `/plugin install`.
- GitHub Actions: build workflow on push, release workflow on tag.
