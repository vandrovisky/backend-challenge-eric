import type { Labels, Metrics } from "../../application/ports/observability";

type Kind = "counter" | "gauge" | "histogram";

/**
 * Catalog of every metric the service emits. Rendering uses it for `# HELP` / `# TYPE`, and it doubles
 * as documentation: this list is what an operator dashboards and alerts on.
 */
export const METRIC_CATALOG: Record<string, { kind: Kind; help: string }> = {
  // processing
  wager_transactions_total: { kind: "counter", help: "Transactions decided, by status and kind" },
  wager_duplicates_total: { kind: "counter", help: "Idempotent replays served (duplicate submissions), by source" },
  wager_idempotency_conflicts_total: { kind: "counter", help: "Same idempotency key with a different payload" },
  wager_retries_total: { kind: "counter", help: "Internal retries of the submit use case, by reason" },
  wager_lock_conflicts_total: {
    kind: "counter",
    help: "Concurrency conflicts: lock timeouts, deadlocks, version conflicts, duplicate-key races",
  },
  wallet_lock_wait_ms: { kind: "histogram", help: "Time waiting for the wallet row lock (hot-wallet signal)" },
  wager_processing_duration_ms: { kind: "histogram", help: "End-to-end submit latency, by kind" },
  wallets_opened_total: { kind: "counter", help: "Wallets created" },
  pending_reference_errors_total: { kind: "counter", help: "Errors while re-checking PENDING_REFERENCE transactions" },
  pending_references: { kind: "gauge", help: "Transactions currently waiting for their reference (global)" },
  // reconciliation
  reconciliations_total: { kind: "counter", help: "Reconciliation checks, by outcome" },
  reconciliation_divergences_total: { kind: "counter", help: "Reconciliations where balance != ledger replay" },
  // queue
  sqs_message_handling_ms: { kind: "histogram", help: "Time to handle one queue message, by disposition" },
  sqs_retries_total: { kind: "counter", help: "Messages left for redelivery after a transient failure" },
  sqs_dlq_messages_total: { kind: "counter", help: "Messages this instance moved to the DLQ, by reason" },
  sqs_dlq_depth: { kind: "gauge", help: "Approximate messages sitting in the DLQ (global)" },
  sqs_receive_errors_total: { kind: "counter", help: "ReceiveMessage failures" },
  sqs_ack_errors_total: { kind: "counter", help: "Failures deleting/releasing a message (safe: it is redelivered)" },
  // outbox
  outbox_published_total: { kind: "counter", help: "Outbox events published" },
  outbox_publish_failures_total: { kind: "counter", help: "Outbox publish attempts that failed and were rescheduled" },
  outbox_pending: { kind: "gauge", help: "Unpublished outbox events (global)" },
  outbox_lag_ms: { kind: "gauge", help: "Age of the oldest unpublished outbox event (global)" },
  // http
  http_requests_total: { kind: "counter", help: "HTTP requests, by method, route and status" },
  http_request_duration_ms: { kind: "histogram", help: "HTTP request latency, by method and route" },
};

const BUCKETS_MS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

interface Histogram {
  buckets: number[];
  sum: number;
  count: number;
}

function series(name: string, labels: Labels = {}): string {
  const parts = Object.keys(labels)
    .sort()
    .map((k) => `${k}="${String(labels[k]).replace(/["\\\n]/g, "_")}"`);
  return parts.length ? `${name}{${parts.join(",")}}` : name;
}

/** In-process metrics with Prometheus text exposition (served at GET /metrics, scraped per instance). */
export class MetricsRegistry implements Metrics {
  private readonly counters = new Map<string, { name: string; value: number }>();
  private readonly gauges = new Map<string, { name: string; value: number }>();
  private readonly histograms = new Map<string, { name: string; labels: Labels; h: Histogram }>();

  increment(name: string, labels?: Labels, by = 1): void {
    const k = series(name, labels);
    const entry = this.counters.get(k) ?? { name, value: 0 };
    entry.value += by;
    this.counters.set(k, entry);
  }

  gauge(name: string, value: number, labels?: Labels): void {
    this.gauges.set(series(name, labels), { name, value });
  }

  observe(name: string, value: number, labels: Labels = {}): void {
    const k = series(name, labels);
    let entry = this.histograms.get(k);
    if (!entry) {
      entry = { name, labels, h: { buckets: BUCKETS_MS.map(() => 0), sum: 0, count: 0 } };
      this.histograms.set(k, entry);
    }
    BUCKETS_MS.forEach((b, i) => {
      if (value <= b) entry.h.buckets[i]! += 1;
    });
    entry.h.sum += value;
    entry.h.count += 1;
  }

  /** Current value of a counter (tests, diagnostics). */
  counter(name: string, labels?: Labels): number {
    return this.counters.get(series(name, labels))?.value ?? 0;
  }

  /** Sum of a counter across all label combinations. */
  counterTotal(name: string): number {
    let total = 0;
    for (const c of this.counters.values()) if (c.name === name) total += c.value;
    return total;
  }

  histogramCount(name: string): number {
    let total = 0;
    for (const h of this.histograms.values()) if (h.name === name) total += h.h.count;
    return total;
  }

  render(): string {
    const byName = new Map<string, string[]>();
    const add = (name: string, line: string) => byName.set(name, [...(byName.get(name) ?? []), line]);

    for (const [k, c] of this.counters) add(c.name, `${k} ${c.value}`);
    for (const [k, g] of this.gauges) add(g.name, `${k} ${g.value}`);
    for (const { name, labels, h } of this.histograms.values()) {
      BUCKETS_MS.forEach((b, i) => add(name, `${series(`${name}_bucket`, { ...labels, le: String(b) })} ${h.buckets[i]}`));
      add(name, `${series(`${name}_bucket`, { ...labels, le: "+Inf" })} ${h.count}`);
      add(name, `${series(`${name}_sum`, labels)} ${Math.round(h.sum * 1000) / 1000}`);
      add(name, `${series(`${name}_count`, labels)} ${h.count}`);
    }

    const out: string[] = [];
    for (const name of [...byName.keys()].sort()) {
      const meta = METRIC_CATALOG[name];
      if (meta) {
        out.push(`# HELP ${name} ${meta.help}`);
        out.push(`# TYPE ${name} ${meta.kind}`);
      }
      out.push(...byName.get(name)!);
    }
    return `${out.join("\n")}\n`;
  }
}
