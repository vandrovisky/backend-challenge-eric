import { DomainError } from "../../domain/shared/domain-error";
import { Money, type MoneyProps } from "../../domain/shared/money";
import { SUBMITTABLE_KINDS, type WagerTransactionKind } from "../../domain/wagering/wager-transaction";
import { PayloadValidationError } from "../errors";
import { wagerPayloadHash, type WagerPayloadFields } from "../idempotency/payload-hash";

/** Raw submission as received from HTTP (body + Idempotency-Key header) or SQS (message.data). */
export interface SubmitWagerCommand {
  idempotencyKey: unknown;
  providerId: unknown;
  externalTransactionId: unknown;
  playerId: unknown;
  walletId: unknown;
  roundId: unknown;
  gameId: unknown;
  kind: unknown;
  money: unknown;
  referenceExternalTransactionId?: unknown;
}

export interface ValidatedWagerCommand extends WagerPayloadFields {
  idempotencyKey: string;
  payloadHash: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(field: string, value: unknown, max: number, errors: Record<string, string>): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors[field] = "must be a non-empty string";
    return "";
  }
  if (value.length > max) errors[field] = `must be at most ${max} characters`;
  return value;
}

function uuid(field: string, value: unknown, errors: Record<string, string>): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    errors[field] = "must be a UUID";
    return "";
  }
  return value.toLowerCase();
}

/**
 * Validates the shape of a submission and computes its payload hash.
 * Throws PayloadValidationError with per-field details; never touches the database.
 */
export function validateWagerCommand(cmd: SubmitWagerCommand): ValidatedWagerCommand {
  const errors: Record<string, string> = {};
  const idempotencyKey = text("idempotencyKey", cmd.idempotencyKey, 512, errors);
  const providerId = text("providerId", cmd.providerId, 128, errors);
  const externalTransactionId = text("externalTransactionId", cmd.externalTransactionId, 255, errors);
  const playerId = uuid("playerId", cmd.playerId, errors);
  const walletId = uuid("walletId", cmd.walletId, errors);
  const roundId = text("roundId", cmd.roundId, 255, errors);
  const gameId = text("gameId", cmd.gameId, 255, errors);

  let kind = cmd.kind as WagerTransactionKind;
  if (typeof cmd.kind !== "string" || !SUBMITTABLE_KINDS.includes(kind)) {
    errors.kind = `must be one of ${SUBMITTABLE_KINDS.join(", ")}`;
  }
  if (providerId === "internal") errors.providerId = "is reserved";

  let referenceExternalTransactionId: string | undefined;
  if (cmd.referenceExternalTransactionId !== undefined && cmd.referenceExternalTransactionId !== null) {
    referenceExternalTransactionId = text("referenceExternalTransactionId", cmd.referenceExternalTransactionId, 255, errors);
  }

  let money: Money | undefined;
  try {
    money = Money.from(cmd.money as MoneyProps);
  } catch (e) {
    errors.money = e instanceof DomainError ? e.message : "invalid money";
  }

  if (Object.keys(errors).length > 0 || !money) {
    throw new PayloadValidationError("Invalid wager transaction payload", { fields: errors });
  }

  const fields: WagerPayloadFields = {
    providerId,
    externalTransactionId,
    playerId,
    walletId,
    roundId,
    gameId,
    kind,
    money,
    referenceExternalTransactionId,
  };
  return { ...fields, idempotencyKey, payloadHash: wagerPayloadHash(fields) };
}
