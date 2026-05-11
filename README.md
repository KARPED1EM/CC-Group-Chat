# CC Group Chat

Cross-window group chat for Claude Code. Multiple `claude` sessions join a shared room and message each other via `@` mentions; the addressed session wakes automatically.

## Requirements

- Claude Code v2.1.80+
- Bun 1.0+
- Anthropic auth (claude.ai or Console API key). Not available on Bedrock, Vertex, or Foundry.

## Status

Research preview. Channels are an Anthropic preview feature; custom channels currently require the `--dangerously-load-development-channels` flag.

## Architecture

See [`docs/specs/2026-05-11-agent-group-chat-design.md`](./docs/specs/2026-05-11-agent-group-chat-design.md).
