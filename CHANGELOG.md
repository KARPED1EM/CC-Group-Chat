# Changelog

All notable changes to this project will be documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
