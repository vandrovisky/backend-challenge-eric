import type { IntegrationEvent } from "./integration-event";

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 60_000;

/**
 * Event waiting to be published. Written in the same SQL transaction as the state change it
 * describes; a separate publisher delivers it after commit (at-least-once). The outbox id is the
 * event id, so consumers dedupe duplicates by `eventId`.
 */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const payload = event.toJSON() as unknown as Record<string, unknown>;
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      Object.freeze(payload),
      new Date(event.occurredAt),
      0,
      new Date(event.occurredAt),
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      new Date(state.occurredAt),
      state.attempts,
      state.nextAttemptAt && new Date(state.nextAttemptAt),
      state.publishedAt && new Date(state.publishedAt),
    );
  }

  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }
  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (!this._nextAttemptAt || this._nextAttemptAt.getTime() <= now.getTime());
  }

  markPublished(at: Date): void {
    if (this._publishedAt) return;
    this._publishedAt = new Date(at);
    this._nextAttemptAt = undefined;
  }

  /** Increments attempts and schedules the next try with capped exponential backoff. */
  scheduleRetry(now: Date): void {
    this._attempts += 1;
    const delay = Math.min(BASE_DELAY_MS * 2 ** (this._attempts - 1), MAX_DELAY_MS);
    this._nextAttemptAt = new Date(now.getTime() + delay);
  }
}
