// Compute the room id this channel server should bind to.
// Resolution order, highest priority first:
//   1. CC_GROUP_CHAT_ROOM           — explicit literal room id
//   2. CC_GROUP_CHAT_ROOM_FROM_DIR  — path whose cwd-hash names the room
//   3. fallback: cwd-hash of the channel server's own working directory

import { getDefaultRoomId } from '@cc-group-chat/shared'

export interface ResolveRoomOptions {
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly cwd?: string
}

export function resolveRoomId(opts: ResolveRoomOptions = {}): string {
  const env = opts.env ?? process.env
  const cwd = opts.cwd ?? process.cwd()

  const explicit = env.CC_GROUP_CHAT_ROOM
  if (explicit !== undefined && explicit !== '') return explicit

  const fromDir = env.CC_GROUP_CHAT_ROOM_FROM_DIR
  if (fromDir !== undefined && fromDir !== '') return getDefaultRoomId(fromDir)

  return getDefaultRoomId(cwd)
}
