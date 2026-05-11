// Domain types shared by the broker daemon and the per-session channel server.

/** A session that has joined the room. */
export interface Member {
  /** Unique identifier within the room. Matches the `@`-mention syntax. */
  readonly name: string
  /** Free-form short self-description. Capped at 280 characters. */
  readonly description: string
  /** Unix milliseconds at which this member joined. */
  readonly joinedAt: number
}

/** A message persisted in the room's history. */
export interface RoomMessage {
  /** Monotonically increasing within the room. */
  readonly id: number
  /** Name of the speaker. */
  readonly from: string
  /** Raw message text as the speaker provided it. */
  readonly text: string
  /** Unix milliseconds at which the broker received the message. */
  readonly at: number
  /** Parsed `@`-targets from the text, including the literal `everyone`. */
  readonly mentions: readonly string[]
}

/** Outcome of a `Room.speak` call. */
export interface SpeakResult {
  /** The persisted message. */
  readonly message: RoomMessage
  /** Member names that were woken by this message. */
  readonly delivered: readonly string[]
  /** Member names whose per-session wake budget was exhausted; they were not woken. */
  readonly throttled: readonly string[]
  /** `true` when the speaker requested `@everyone` but the cooldown blocked the broadcast. */
  readonly everyoneThrottled: boolean
}
