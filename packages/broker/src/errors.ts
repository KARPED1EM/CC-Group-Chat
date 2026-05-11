export type ChatErrorCode =
  | 'DUPLICATE_NAME'
  | 'INVALID_NAME'
  | 'RESERVED_NAME'
  | 'NOT_MEMBER'
  | 'ROOM_FULL'

export class ChatError extends Error {
  readonly code: ChatErrorCode

  constructor(code: ChatErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = 'ChatError'
  }
}
