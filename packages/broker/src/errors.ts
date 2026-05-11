export type ChatErrorCode =
  | 'DUPLICATE_NAME'
  | 'INVALID_NAME'
  | 'INVALID_DESCRIPTION'
  | 'RESERVED_NAME'
  | 'NOT_MEMBER'
  | 'ROOM_FULL'
  | 'NOT_CONNECTED'
  | 'NOT_JOINED'
  | 'ALREADY_JOINED'

export class ChatError extends Error {
  readonly code: ChatErrorCode

  constructor(code: ChatErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = 'ChatError'
  }
}
