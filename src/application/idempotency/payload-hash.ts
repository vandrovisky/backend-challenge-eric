import { createHash } from "node:crypto";
import type { Money } from "../../domain/shared/money";
import type { WagerTransactionKind } from "../../domain/wagering/wager-transaction";

/** Business fields of a submission. Transport metadata (headers, messageId, occurredAt) is excluded. */
export interface WagerPayloadFields {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
}

/**
 * Canonical JSON: object keys sorted recursively by code point, no whitespace,
 * `undefined` members dropped. Arrays keep their order.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/**
 * payloadHash = "sha256:" + hex(SHA-256(canonicalJson(fields))).
 * Money is normalized through `toJSON()` first, so "25" and "25.00" hash identically.
 */
export function wagerPayloadHash(fields: WagerPayloadFields): string {
  const canonical = canonicalJson({
    providerId: fields.providerId,
    externalTransactionId: fields.externalTransactionId,
    playerId: fields.playerId,
    walletId: fields.walletId,
    roundId: fields.roundId,
    gameId: fields.gameId,
    kind: fields.kind,
    money: fields.money.toJSON(),
    referenceExternalTransactionId: fields.referenceExternalTransactionId || undefined,
  });
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}
