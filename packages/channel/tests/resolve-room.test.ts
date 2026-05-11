import { describe, test, expect } from 'bun:test'
import { getDefaultRoomId } from '@cc-group-chat/shared'
import { resolveRoomId } from '../src/resolve-room.ts'

describe('resolveRoomId', () => {
  test('prefers CC_GROUP_CHAT_ROOM when set', () => {
    expect(resolveRoomId({ env: { CC_GROUP_CHAT_ROOM: 'team-auth' }, cwd: '/anywhere' }))
      .toBe('team-auth')
  })

  test('uses CC_GROUP_CHAT_ROOM_FROM_DIR when no explicit room', () => {
    const id = resolveRoomId({ env: { CC_GROUP_CHAT_ROOM_FROM_DIR: process.cwd() }, cwd: '/other' })
    expect(id).toBe(getDefaultRoomId(process.cwd()))
    expect(id).toMatch(/^auto-[0-9a-f]{8}$/)
  })

  test('falls back to cwd hash when no env is set', () => {
    expect(resolveRoomId({ env: {}, cwd: process.cwd() }))
      .toBe(getDefaultRoomId(process.cwd()))
  })

  test('empty CC_GROUP_CHAT_ROOM is ignored', () => {
    const id = resolveRoomId({ env: { CC_GROUP_CHAT_ROOM: '' }, cwd: process.cwd() })
    expect(id).toBe(getDefaultRoomId(process.cwd()))
  })

  test('CC_GROUP_CHAT_ROOM beats CC_GROUP_CHAT_ROOM_FROM_DIR when both set', () => {
    expect(resolveRoomId({
      env: { CC_GROUP_CHAT_ROOM: 'literal', CC_GROUP_CHAT_ROOM_FROM_DIR: '/some/dir' },
      cwd: '/elsewhere',
    })).toBe('literal')
  })

  test('two different dirs produce different ids', () => {
    const a = resolveRoomId({ env: { CC_GROUP_CHAT_ROOM_FROM_DIR: process.cwd() } })
    const b = resolveRoomId({ env: { CC_GROUP_CHAT_ROOM_FROM_DIR: '/some/other/path/that/does/not/exist' } })
    expect(a).not.toBe(b)
  })
})
