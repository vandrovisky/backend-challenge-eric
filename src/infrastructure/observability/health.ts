import { GetQueueAttributesCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { MikroORM } from "@mikro-orm/postgresql";
import type { QueueUrls } from "../messaging/sqs-client";

export interface DependencyStatus {
  status: "up" | "down";
  latencyMs: number;
  error?: string;
}

export interface ReadinessReport {
  status: "ready" | "not_ready";
  checks: Record<string, DependencyStatus>;
}

export interface HealthIndicator {
  readonly name: string;
  check(): Promise<void>;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)),
  ]);
}

export class PostgresHealthIndicator implements HealthIndicator {
  readonly name = "postgres";
  constructor(private readonly orm: MikroORM) {}
  async check(): Promise<void> {
    await this.orm.em.fork().execute("SELECT 1");
  }
}

export class SqsHealthIndicator implements HealthIndicator {
  readonly name = "sqs";
  constructor(
    private readonly client: SQSClient,
    private readonly urls: QueueUrls,
    private readonly queueName: string,
  ) {}
  async check(): Promise<void> {
    const QueueUrl = await this.urls.get(this.queueName);
    await this.client.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ["QueueArn"] }));
  }
}

/** Readiness = every dependency answers within the timeout. Liveness never touches dependencies. */
export class HealthService {
  constructor(
    private readonly indicators: HealthIndicator[],
    private readonly timeoutMs = 2_000,
  ) {}

  async readiness(): Promise<ReadinessReport> {
    const entries = await Promise.all(
      this.indicators.map(async (indicator): Promise<[string, DependencyStatus]> => {
        const started = performance.now();
        try {
          await withTimeout(indicator.check(), this.timeoutMs, indicator.name);
          return [indicator.name, { status: "up", latencyMs: Math.round(performance.now() - started) }];
        } catch (e) {
          return [
            indicator.name,
            {
              status: "down",
              latencyMs: Math.round(performance.now() - started),
              error: e instanceof Error ? e.message.slice(0, 200) : "unknown",
            },
          ];
        }
      }),
    );
    const checks = Object.fromEntries(entries);
    return { status: entries.every(([, s]) => s.status === "up") ? "ready" : "not_ready", checks };
  }
}
