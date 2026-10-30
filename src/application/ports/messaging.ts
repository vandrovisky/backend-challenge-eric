import type { OutboxMessage } from "../../domain/messaging/outbox-message";

export interface PublishResult {
  id: string;
  ok: boolean;
  error?: string;
}

/** Delivers integration events to the broker. At-least-once: consumers dedupe by `eventId`. */
export interface EventPublisher {
  publish(messages: OutboxMessage[]): Promise<PublishResult[]>;
}
