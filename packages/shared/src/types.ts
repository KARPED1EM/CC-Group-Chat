// Domain types shared by the broker daemon and the per-session channel server.

/** Whether a member has been active recently. */
export type Engagement = 'idle' | 'engaged'

/** A session that has joined the room. */
export interface Member {
  /** Unique identifier within the room. Matches the `@`-mention syntax. */
  readonly name: string
  /** Free-form short self-description. Capped at 280 characters. */
  readonly description: string
  /** Unix milliseconds at which this member joined. */
  readonly joinedAt: number
  /**
   * Computed from the time since the member last invoked any group-chat tool.
   * `engaged` while activity happened within the engagement window (60s);
   * `idle` once it stops. Lets observers distinguish "agent is processing"
   * from "agent has gone quiet without leaving".
   */
  readonly engagement: Engagement
}

/** A message persisted in the room's history. */
export interface RoomMessage {
  /** Monotonically increasing within the room. */
  readonly id: number
  /** Id of the room this message was spoken in. */
  readonly roomId: string
  /** Name of the speaker. */
  readonly from: string
  /** Raw message text as the speaker provided it. */
  readonly text: string
  /** Unix milliseconds at which the broker received the message. */
  readonly at: number
  /** Parsed `@`-targets from the text, including the literal `everyone`. */
  readonly mentions: readonly string[]
}

/** Discriminated union returned by `Broker.speak`. */
export type SpeakResult = SpeakOk | SpeakRateLimited

export interface SpeakOk {
  readonly ok: true
  /** The persisted message. */
  readonly message: RoomMessage
  /** Member names that were intended for push delivery (queued or sent). */
  readonly delivered: readonly string[]
}

export interface SpeakRateLimited {
  readonly ok: false
  readonly reason: 'rate_limited'
}

/** A batch of room messages destined for a single recipient connection. */
export interface RoomBatch {
  readonly roomId: string
  readonly messages: readonly RoomMessage[]
}
