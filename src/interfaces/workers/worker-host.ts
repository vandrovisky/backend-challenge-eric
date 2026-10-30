import type { Core } from "../../composition-root";
import type { WagerMessageConsumer } from "../sqs/wager-message-consumer";
import { PeriodicWorker } from "./periodic-worker";

export type WorkerName = "consumer" | "outbox" | "references" | "sampler";
export const ALL_WORKERS: WorkerName[] = ["consumer", "outbox", "references", "sampler"];

/** Parses WORKERS="consumer,outbox,references,sampler" (default: all; "none" disables). */
export function workersFromEnv(value = process.env.WORKERS): WorkerName[] {
  if (!value) return ALL_WORKERS;
  if (value === "none") return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is WorkerName => (ALL_WORKERS as string[]).includes(s));
}

/**
 * Background workers of one instance. Every worker is safe to run on all instances at once:
 * correctness comes from the database (inbox, row locks, SKIP LOCKED), not from leader election.
 */
export class WorkerHost {
  private readonly consumer?: WagerMessageConsumer;
  private readonly periodic: PeriodicWorker[] = [];

  constructor(core: Core, enabled: WorkerName[] = ALL_WORKERS) {
    if (enabled.includes("consumer")) this.consumer = core.createConsumer();
    if (enabled.includes("outbox")) {
      this.periodic.push(
        new PeriodicWorker("outbox-publisher", async () => (await core.publishOutbox.runOnce()).claimed, core.logger, {
          idleMs: 500,
          errorBackoffMs: 2_000,
        }),
      );
    }
    if (enabled.includes("references")) {
      this.periodic.push(
        new PeriodicWorker(
          "pending-references",
          async () => {
            const s = await core.reprocessPendingReferences.runOnce();
            return s.processed + s.rejected;
          },
          core.logger,
          { idleMs: 1_000, errorBackoffMs: 2_000 },
        ),
      );
    }
    if (enabled.includes("sampler")) {
      this.periodic.push(
        new PeriodicWorker(
          "gauge-sampler",
          async () => {
            await core.sampler.sample();
            return 0; // always idle-wait: sampling is periodic, not backlog-driven
          },
          core.logger,
          { idleMs: 10_000, errorBackoffMs: 10_000 },
        ),
      );
    }
  }

  start(): void {
    this.consumer?.start();
    for (const w of this.periodic) w.start();
  }

  /** Stop intake first (consumer), then let the relays finish their current tick. */
  async stop(): Promise<void> {
    await this.consumer?.stop();
    await Promise.all(this.periodic.map((w) => w.stop()));
  }
}
