import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import type { SQL } from "bun";
import { createCore, type Core } from "../../src/composition-root";
import { newId } from "../../src/domain/shared/id";
import { silentLogger } from "../../src/infrastructure/observability/json-logger";
import { createHttpApp } from "../../src/interfaces/http/http-app";
import { connect, resetDatabase } from "./support/database";
import { brl } from "./support/fixtures";

let core: Core;
let app: INestApplication;
let base: string;
let sql: SQL;

beforeAll(async () => {
  await resetDatabase();
  core = await createCore({ poolMax: 20, logger: silentLogger });
  app = await createHttpApp(core);
  await app.listen(0, "127.0.0.1");
  base = (await app.getUrl()).replace("[::1]", "127.0.0.1");
  sql = connect();
});

afterAll(async () => {
  await app?.close();
  await core?.close();
  await sql?.close();
});

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, headers: res.headers, body: json };
}

async function createWallet(amount = "1000.00") {
  const playerId = newId();
  const r = await call("POST", "/wallets", { playerId, initialBalance: brl(amount) });
  expect(r.status).toBe(201);
  return { walletId: r.body.id as string, playerId };
}

function tx(w: { walletId: string; playerId: string }, kind: string, amount: string, extra: Record<string, unknown> = {}) {
  const externalTransactionId = (extra.externalTransactionId as string) ?? `t-${newId()}`;
  return {
    body: {
      providerId: "provider-a",
      externalTransactionId,
      playerId: w.playerId,
      walletId: w.walletId,
      roundId: "round-987",
      gameId: "fortune-chimp",
      kind,
      money: brl(amount),
      ...extra,
    },
    headers: { "Idempotency-Key": `provider-a:${externalTransactionId}` },
  };
}

describe("POST /wallets", () => {
  test("creates a wallet with the README response shape; duplicate → 409", async () => {
    const playerId = newId();
    const r = await call("POST", "/wallets", { playerId, initialBalance: brl("1000.00") });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ id: expect.any(String), playerId, balance: brl("1000.00"), version: 1 });
    expect(r.headers.get("x-correlation-id")).toBeTruthy();

    const dup = await call("POST", "/wallets", { playerId, initialBalance: brl("5.00") });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("WALLET_ALREADY_EXISTS");
  });

  test("invalid money → 400 with field details; malformed JSON → 400 INVALID_JSON", async () => {
    const r = await call("POST", "/wallets", { playerId: newId(), initialBalance: { amount: 10, currency: "BRL" } });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("INVALID_PAYLOAD");
    expect(r.body.error.details.fields.initialBalance).toBeTruthy();

    const bad = await call("POST", "/wallets", "{not json");
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("INVALID_JSON");
  });
});

describe("POST /wagering/transactions — status codes", () => {
  test("201 processed, 200 replay (same body + Idempotent-Replayed), 409 conflicting payload", async () => {
    const w = await createWallet();
    const t = tx(w, "BET", "25.00");
    const first = await call("POST", "/wagering/transactions", t.body, t.headers);
    expect(first.status).toBe(201);
    expect(first.body).toEqual({
      transactionId: expect.any(String),
      status: "PROCESSED",
      balance: brl("975.00"),
      idempotentReplay: false,
    });

    const again = await call("POST", "/wagering/transactions", t.body, t.headers);
    expect(again.status).toBe(200);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(again.body).toEqual({ ...first.body, idempotentReplay: true });

    const conflict = await call("POST", "/wagering/transactions", { ...t.body, money: brl("26.00") }, t.headers);
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  test("422 business rejection carries failureCode; replay keeps 422", async () => {
    const w = await createWallet("10.00");
    const t = tx(w, "BET", "50.00");
    const r = await call("POST", "/wagering/transactions", t.body, t.headers);
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ status: "REJECTED", failureCode: "INSUFFICIENT_FUNDS", balance: brl("10.00") });
    const replay = await call("POST", "/wagering/transactions", t.body, t.headers);
    expect(replay.status).toBe(422);
    expect(replay.body.idempotentReplay).toBe(true);
  });

  test("202 accepted when the reference has not arrived yet", async () => {
    const w = await createWallet();
    const t = tx(w, "REFUND", "10.00", { referenceExternalTransactionId: `missing-${newId()}` });
    const r = await call("POST", "/wagering/transactions", t.body, t.headers);
    expect(r.status).toBe(202);
    expect(r.body.status).toBe("PENDING_REFERENCE");
  });

  test("400 for missing Idempotency-Key, OPENING kind, float money, scientific notation", async () => {
    const w = await createWallet();
    const t = tx(w, "BET", "1.00");
    const noKey = await call("POST", "/wagering/transactions", t.body);
    expect(noKey.status).toBe(400);
    expect(noKey.body.error.details.fields["Idempotency-Key"]).toBe("required");

    for (const body of [
      { ...t.body, kind: "OPENING" },
      { ...t.body, money: { amount: 1.5, currency: "BRL" } },
      { ...t.body, money: { amount: "1e2", currency: "BRL" } },
      { ...t.body, kind: "REFUND" }, // missing reference
      { ...t.body, walletId: "not-a-uuid" },
    ]) {
      const r = await call("POST", "/wagering/transactions", body, t.headers);
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("INVALID_PAYLOAD");
    }
  });

  test("503 + Retry-After when the database is unreachable", async () => {
    // The pool connects lazily, so the app boots with the database down and degrades per request.
    const down = await createCore({
      logger: silentLogger,
      config: { databaseUrl: "postgres://wagering:wagering@127.0.0.1:1/wagering" },
    });
    const downApp = await createHttpApp(down);
    await downApp.listen(0, "127.0.0.1");
    const url = (await downApp.getUrl()).replace("[::1]", "127.0.0.1");
    try {
      const w = { walletId: newId(), playerId: newId() };
      const t = tx(w, "BET", "1.00");
      const res = await fetch(`${url}/wagering/transactions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...t.headers },
        body: JSON.stringify(t.body),
      });
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("1");
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("TRANSIENT_INFRASTRUCTURE_ERROR");

      const ready = await fetch(`${url}/health/ready`);
      expect(ready.status).toBe(503);
      const live = await fetch(`${url}/health/live`);
      expect(live.status).toBe(200);
    } finally {
      await downApp.close();
      await down.close().catch(() => undefined);
    }
  });

  test("mandatory scenario over HTTP: two parallel 80.00 bets on 100.00", async () => {
    const w = await createWallet("100.00");
    const [a, b] = await Promise.all([
      (() => {
        const t = tx(w, "BET", "80.00");
        return call("POST", "/wagering/transactions", t.body, t.headers);
      })(),
      (() => {
        const t = tx(w, "BET", "80.00");
        return call("POST", "/wagering/transactions", t.body, t.headers);
      })(),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 422]);
    const wallet = await call("GET", `/wallets/${w.walletId}`);
    expect(wallet.body.balance).toEqual(brl("20.00"));
  });
});

describe("queries", () => {
  test("GET wallet / transaction by id / by provider external id; unknown → 404", async () => {
    const w = await createWallet();
    const t = tx(w, "BET", "5.00");
    const created = await call("POST", "/wagering/transactions", t.body, t.headers);

    const wallet = await call("GET", `/wallets/${w.walletId}`);
    expect(wallet.body).toMatchObject({ id: w.walletId, balance: brl("995.00"), version: 2 });

    const byId = await call("GET", `/wagering/transactions/${created.body.transactionId}`);
    expect(byId.body).toMatchObject({ id: created.body.transactionId, kind: "BET", status: "PROCESSED", money: brl("5.00") });

    const byExt = await call("GET", `/providers/provider-a/wagering/transactions/${t.body.externalTransactionId}`);
    expect(byExt.body.id).toBe(created.body.transactionId);

    expect((await call("GET", `/wallets/${newId()}`)).status).toBe(404);
    expect((await call("GET", `/wagering/transactions/${newId()}`)).status).toBe(404);
    expect((await call("GET", `/wallets/not-a-uuid`)).status).toBe(400);
  });

  test("ledger pagination: stable opaque cursor, no gaps or duplicates while new entries arrive", async () => {
    const w = await createWallet("1000.00");
    for (let i = 0; i < 7; i++) {
      const t = tx(w, "BET", "1.00");
      await call("POST", "/wagering/transactions", t.body, t.headers);
    }
    const seen: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const qs: string = cursor ? `?limit=3&cursor=${cursor}` : "?limit=3";
      const page = await call("GET", `/wallets/${w.walletId}/ledger${qs}`);
      expect(page.status).toBe(200);
      seen.push(...page.body.items.map((e: { walletVersion: number }) => e.walletVersion));
      cursor = page.body.nextCursor;
      if (pages === 0) {
        // a write in the middle of pagination must not shift later pages
        const t = tx(w, "WIN", "2.00");
        await call("POST", "/wagering/transactions", t.body, t.headers);
      }
      pages += 1;
    } while (cursor);
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);

    expect((await call("GET", `/wallets/${w.walletId}/ledger?cursor=garbage`)).status).toBe(400);
    expect((await call("GET", `/wallets/${w.walletId}/ledger?limit=0`)).status).toBe(400);
    expect((await call("GET", `/wallets/${w.walletId}/ledger?limit=500`)).status).toBe(400);
  });
});

describe("POST /wallets/:id/reconciliation", () => {
  test("consistent wallet", async () => {
    const w = await createWallet("975.00");
    const t = tx(w, "BET", "25.00");
    await call("POST", "/wagering/transactions", t.body, t.headers);
    const r = await call("POST", `/wallets/${w.walletId}/reconciliation`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      walletId: w.walletId,
      storedBalance: brl("950.00"),
      calculatedBalance: brl("950.00"),
      difference: brl("0.00"),
      consistent: true,
      checkedEntries: 2,
    });
  });

  test("a divergence is reported (not fixed) and counted in metrics", async () => {
    const w = await createWallet("100.00");
    // Simulate corruption the schema would normally refuse: bypass triggers as superuser-like session.
    await sql.begin(async (t) => {
      await t`SET LOCAL session_replication_role = replica`;
      await t`UPDATE wallets SET balance = 90.00 WHERE id = ${w.walletId}`;
    });
    const before = core.metrics.counter("reconciliation_divergences_total");
    const r = await call("POST", `/wallets/${w.walletId}/reconciliation`);
    expect(r.body).toMatchObject({
      consistent: false,
      storedBalance: brl("90.00"),
      calculatedBalance: brl("100.00"),
      difference: { amount: "-10.00", currency: "BRL" },
    });
    expect(core.metrics.counter("reconciliation_divergences_total")).toBe(before + 1);
    // not corrected silently
    expect((await call("GET", `/wallets/${w.walletId}`)).body.balance).toEqual(brl("90.00"));
  });
});

describe("health & metrics", () => {
  test("live and ready are open (no auth) and report dependencies", async () => {
    expect((await call("GET", "/health/live")).body.status).toBe("ok");
    const ready = await call("GET", "/health/ready");
    expect(ready.status).toBe(200);
    expect(ready.body.checks.postgres.status).toBe("up");
    expect(ready.body.checks.sqs.status).toBe("up");
  });

  test("/metrics exposes Prometheus text", async () => {
    const r = await call("GET", "/metrics");
    expect(r.status).toBe(200);
    expect(r.body).toContain("wager_transactions_total");
  });

  test("OpenAPI document and Swagger UI are served", async () => {
    const ui = await fetch(`${base}/docs`);
    expect(ui.status).toBe(200);
    expect(await ui.text()).toContain("swagger-ui");
    const doc = (await call("GET", "/docs-json")).body;
    expect(doc.openapi).toMatch(/^3\./);
    const submit = doc.paths["/wagering/transactions"].post;
    expect(Object.keys(submit.responses).sort()).toEqual(["200", "201", "202", "400", "409", "422", "500", "503"]);
    expect(submit.parameters.find((p: { name: string }) => p.name === "Idempotency-Key").required).toBe(true);
    expect(doc.components.schemas.MoneyDto.properties.amount.type).toBe("string");
  });

  test("unknown route → 404 JSON error", async () => {
    const r = await call("GET", "/nope");
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("NOT_FOUND");
  });
});
