import { describe, expect, test } from "bun:test";
import { JsonLogger, sanitizeText } from "../../src/infrastructure/observability/json-logger";
import { MetricsRegistry } from "../../src/infrastructure/observability/metrics-registry";

function capture() {
  const lines: string[] = [];
  const logger = new JsonLogger({ service: "t" }, "debug", (l) => lines.push(l));
  return { logger, lines, parsed: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

describe("JsonLogger", () => {
  test("emits one JSON object per line with base + child fields", () => {
    const { logger, parsed } = capture();
    logger.child({ correlationId: "c1" }).info("hello", { walletId: "w1", attempt: 2 });
    expect(parsed()[0]).toMatchObject({ level: "info", msg: "hello", service: "t", correlationId: "c1", walletId: "w1", attempt: 2 });
  });

  test("redacts financial / sensitive keys whatever their value", () => {
    const { logger, parsed } = capture();
    logger.info("x", { amount: "25.00", balance: "975.00", payload: "{...}", authorization: "Bearer x", difference: "1.00" });
    const rec = parsed()[0]!;
    for (const k of ["amount", "balance", "payload", "authorization", "difference"]) expect(rec[k]).toBe("[redacted]");
  });

  test("scrubs amounts and row values out of error text", () => {
    expect(sanitizeText("wallet w balance 975.00 at version 3 has no matching ledger entry")).toBe(
      "wallet w balance [amount] at version 3 has no matching ledger entry",
    );
    expect(sanitizeText('duplicate key - detail: Key (player_id, currency)=(abc, BRL) already exists')).toContain(
      "(player_id, currency)=([redacted])",
    );
    const { logger, lines } = capture();
    logger.error("boom", { err: "balance -10.50 would be negative" });
    expect(lines[0]).not.toContain("10.50");
  });

  test("respects the minimum level", () => {
    const lines: string[] = [];
    new JsonLogger({}, "warn", (l) => lines.push(l)).info("ignored");
    expect(lines).toHaveLength(0);
  });
});

describe("MetricsRegistry", () => {
  test("renders Prometheus text with HELP/TYPE from the catalog", () => {
    const m = new MetricsRegistry();
    m.increment("wager_transactions_total", { status: "PROCESSED", kind: "BET" });
    m.increment("wager_transactions_total", { status: "PROCESSED", kind: "BET" });
    m.gauge("outbox_lag_ms", 1234);
    m.observe("wallet_lock_wait_ms", 7);
    const text = m.render();
    expect(text).toContain("# TYPE wager_transactions_total counter");
    expect(text).toContain('wager_transactions_total{kind="BET",status="PROCESSED"} 2');
    expect(text).toContain("# TYPE outbox_lag_ms gauge");
    expect(text).toContain("outbox_lag_ms 1234");
    expect(text).toContain("# TYPE wallet_lock_wait_ms histogram");
    expect(text).toContain('wallet_lock_wait_ms_bucket{le="5"} 0');
    expect(text).toContain('wallet_lock_wait_ms_bucket{le="10"} 1');
    expect(text).toContain("wallet_lock_wait_ms_count 1");
  });

  test("label values are escaped and order-independent", () => {
    const m = new MetricsRegistry();
    m.increment("x_total", { b: "2", a: '1"' });
    m.increment("x_total", { a: '1"', b: "2" });
    expect(m.counter("x_total", { a: '1"', b: "2" })).toBe(2);
    expect(m.render()).toContain('x_total{a="1_",b="2"} 2');
  });
});
