import { describe, expect, test } from "bun:test";
import { canonicalJson, wagerPayloadHash, type WagerPayloadFields } from "../../src/application/idempotency/payload-hash";
import { WalletBalanceChanged } from "../../src/domain/messaging/events";
import { InboxMessage } from "../../src/domain/messaging/inbox-message";
import { OutboxMessage } from "../../src/domain/messaging/outbox-message";
import { Money } from "../../src/domain/shared/money";
import { WagerTransactionKind } from "../../src/domain/wagering/wager-transaction";
import { Wallet } from "../../src/domain/wallet/wallet";

const at = new Date("2026-07-29T15:00:00Z");
const fields: WagerPayloadFields = {
  providerId: "provider-a",
  externalTransactionId: "transaction-123",
  playerId: "p1",
  walletId: "w1",
  roundId: "round-987",
  gameId: "fortune-chimp",
  kind: WagerTransactionKind.Bet,
  money: Money.from({ amount: "25.00", currency: "BRL" }),
};

describe("payload hash / idempotency", () => {
  test("canonical JSON sorts keys recursively and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[2,{"y":2,"z":1}]},"b":1}',
    );
  });

  test("same business fields → same hash regardless of formatting", () => {
    const h1 = wagerPayloadHash(fields);
    const h2 = wagerPayloadHash({ ...fields, money: Money.from({ amount: "25", currency: "BRL" }) });
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("divergent payload under the same key → different hash (conflict, not replay)", () => {
    const original = wagerPayloadHash(fields);
    expect(wagerPayloadHash({ ...fields, money: Money.from({ amount: "25.01", currency: "BRL" }) })).not.toBe(original);
    expect(wagerPayloadHash({ ...fields, kind: WagerTransactionKind.Win })).not.toBe(original);
    expect(wagerPayloadHash({ ...fields, roundId: "other" })).not.toBe(original);
    expect(wagerPayloadHash({ ...fields, referenceExternalTransactionId: "x" })).not.toBe(original);
  });
});

describe("Outbox / Inbox", () => {
  const { wallet, openingEntry } = Wallet.open({
    id: "w1",
    playerId: "p1",
    initialBalance: Money.from({ amount: "10.00", currency: "BRL" }),
    openingTransactionId: "o",
    at,
  });
  const event = WalletBalanceChanged.from(wallet, openingEntry!, { correlationId: "c1", occurredAt: at });

  test("event envelope carries type and version from the class, money as strings", () => {
    const json = event.toJSON();
    expect(json.eventType).toBe("WalletBalanceChanged");
    expect(json.version).toBe(1);
    expect(json.occurredAt).toBe(at.toISOString());
    expect(json.data.balanceAfter).toEqual({ amount: "10.00", currency: "BRL" });
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  test("outbox message is due immediately, backs off on retry, stops when published", () => {
    const msg = OutboxMessage.enqueue(event);
    expect(msg.id).toBe(event.eventId);
    expect(msg.isDue(at)).toBe(true);
    msg.scheduleRetry(at);
    expect(msg.attempts).toBe(1);
    expect(msg.isDue(at)).toBe(false);
    expect(msg.isDue(new Date(at.getTime() + 1000))).toBe(true);
    msg.scheduleRetry(at);
    expect(msg.nextAttemptAt!.getTime() - at.getTime()).toBe(2000);
    msg.markPublished(at);
    expect(msg.isPending()).toBe(false);
    expect(msg.isDue(new Date(at.getTime() + 1e9))).toBe(false);
  });

  test("inbox markProcessed is idempotent", () => {
    const inbox = InboxMessage.receive({ messageId: "m", consumerName: "c", payloadHash: "h", receivedAt: at });
    expect(inbox.isProcessed()).toBe(false);
    inbox.markProcessed(at);
    inbox.markProcessed(new Date(at.getTime() + 1));
    expect(inbox.processedAt).toEqual(at);
  });
});
