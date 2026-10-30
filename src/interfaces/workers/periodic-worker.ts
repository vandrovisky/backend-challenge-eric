import type { AppLogger } from "../../application/ports/observability";

/**
 * Runs `tick` repeatedly. When a tick did work (returns > 0) the next one starts immediately
 * (drain a backlog fast); when idle it waits `idleMs`; after an error it waits `errorBackoffMs`.
 * `stop()` waits for the current tick to finish — a tick is one SQL transaction, never cut midway.
 */
export class PeriodicWorker {
  private running = false;
  private loop?: Promise<void>;
  private wake?: () => void;

  constructor(
    readonly name: string,
    private readonly tick: () => Promise<number>,
    private readonly logger: AppLogger,
    private readonly opts: { idleMs: number; errorBackoffMs: number },
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
    this.logger.info("worker started", { worker: this.name });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.wake?.();
    await this.loop;
    this.logger.info("worker stopped", { worker: this.name });
  }

  private async run(): Promise<void> {
    while (this.running) {
      let delay = this.opts.idleMs;
      try {
        const done = await this.tick();
        if (done > 0) delay = 0;
      } catch (e) {
        delay = this.opts.errorBackoffMs;
        this.logger.error("worker tick failed", { worker: this.name, err: (e as Error).message });
      }
      if (delay > 0 && this.running) await this.sleep(delay);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}
