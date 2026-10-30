import { expect } from "bun:test";
import type { SQL } from "bun";
import type { SubmitWagerCommand } from "../../../src/application/wagering/wager-command";
import type { Core } from "../../../src/composition-root";
import { newId } from "../../../src/domain/shared/id";

export const brl = (amount: string) => ({ amount, currency: "BRL" });

export async function openWallet(core: Core, amount = "100.00") {
  const playerId = newId();
  const wallet = await core.openWallet.execute(
    { playerId, initialBalance: brl(amount) },
    { correlationId: `test-${playerId}` },
  );
  return { walletId: wallet.id, playerId };
}

let seq = 0;
export function wager(
  w: { walletId: string; playerId: string },
  kind: string,
  amount: string,
  extra: Partial<SubmitWagerCommand> = {},
): SubmitWagerCommand {
  seq += 1;
  const externalTransactionId = (extra.externalTransactionId as string) ?? `tx-${Date.now()}-${seq}-${Math.random()}`;
  return {
    idempotencyKey: `provider-a:${externalTransactionId}`,
    providerId: "provider-a",
    externalTransactionId,
    playerId: w.playerId,
    walletId: w.walletId,
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind,
    money: brl(amount),
    ...extra,
  };
}

export const ctx = (correlationId = `corr-${newId()}`) => ({ correlationId });

/** The global invariant: materialized balance == balance rebuilt from the ledger. */
export async function expectWalletConsistent(sql: SQL, walletId: string, expectedBalance?: string) {
  const [w] = await sql`SELECT balance, version FROM wallets WHERE id = ${walletId}`;
  const [l] = await sql`
    SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0)::numeric(20,2)::text AS total,
           COALESCE(MAX(wallet_version), 1) AS max_version
      FROM wallet_ledger_entries WHERE wallet_id = ${walletId}`;
  expect(l.total).toBe(w.balance);
  expect(Number(l.max_version)).toBe(w.version);
  if (expectedBalance !== undefined) expect(w.balance).toBe(expectedBalance);
}

export async function ledgerEntries(sql: SQL, walletId: string) {
  return sql`SELECT direction, amount, balance_before, balance_after, wallet_version, transaction_id
               FROM wallet_ledger_entries WHERE wallet_id = ${walletId} ORDER BY wallet_version`;
}

export async function outboxFor(sql: SQL, aggregateId: string) {
  return sql`SELECT event_type, payload FROM outbox_messages WHERE aggregate_id = ${aggregateId} ORDER BY occurred_at, event_type`;
}
