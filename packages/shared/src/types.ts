// Domain types shared by the broker daemon and the per-session channel server.

export interface Member {
  readonly name: string
  readonly description: string
  readonly joinedAt: number
}

export interface RoomMessage {
  readonly id: number
  readonly from: string
  readonly text: string
  readonly at: number
  readonly mentions: readonly string[]
}

export interface SpeakResult {
  readonly message: RoomMessage
  readonly delivered: readonly string[]
  readonly throttled: readonly string[]
}
