import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

/*
 * OpenAPI descriptions of the HTTP contract, for /docs only.
 * They do NOT validate anything: validation lives in the domain/application layer and is shared with
 * the SQS consumer. Types are given explicitly (no reliance on emitted decorator metadata).
 */

export class MoneyDto {
  @ApiProperty({
    type: String,
    example: "25.00",
    pattern: "^\\d+(\\.\\d{1,2})?$",
    description: "Decimal string, at most 2 decimal places. Never a JSON number.",
  })
  amount!: string;

  @ApiProperty({ type: String, example: "BRL", pattern: "^[A-Z]{3}$", description: "ISO-4217" })
  currency!: string;
}

// ---------------------------------------------------------------- wallets

export class CreateWalletRequest {
  @ApiProperty({ type: String, format: "uuid", example: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1" })
  playerId!: string;

  @ApiProperty({ type: MoneyDto, example: { amount: "1000.00", currency: "BRL" } })
  initialBalance!: MoneyDto;
}

export class WalletResponse {
  @ApiProperty({ type: String, format: "uuid", example: "0192f291-27dd-7d3f-8071-5f8685deef37" })
  id!: string;

  @ApiProperty({ type: String, format: "uuid", example: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1" })
  playerId!: string;

  @ApiProperty({ type: MoneyDto, example: { amount: "1000.00", currency: "BRL" } })
  balance!: MoneyDto;

  @ApiProperty({ type: Number, example: 1, description: "Starts at 1, increments only when the balance changes" })
  version!: number;
}

export class LedgerEntryResponse {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, format: "uuid" }) transactionId!: string;
  @ApiProperty({ type: String, enum: ["DEBIT", "CREDIT"], example: "DEBIT" }) direction!: string;
  @ApiProperty({ type: MoneyDto, example: { amount: "25.00", currency: "BRL" } }) money!: MoneyDto;
  @ApiProperty({ type: MoneyDto, example: { amount: "1000.00", currency: "BRL" } }) balanceBefore!: MoneyDto;
  @ApiProperty({ type: MoneyDto, example: { amount: "975.00", currency: "BRL" } }) balanceAfter!: MoneyDto;
  @ApiProperty({ type: Number, example: 2 }) walletVersion!: number;
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
}

export class LedgerPageResponse {
  @ApiProperty({ type: [LedgerEntryResponse] }) items!: LedgerEntryResponse[];

  @ApiProperty({
    type: String,
    nullable: true,
    example: "eyJ2Ijo1MH0",
    description: "Opaque cursor for the next page; null on the last page",
  })
  nextCursor!: string | null;
}

export class ReconciliationResponse {
  @ApiProperty({ type: String, format: "uuid" }) walletId!: string;
  @ApiProperty({ type: MoneyDto, example: { amount: "975.00", currency: "BRL" } }) storedBalance!: MoneyDto;
  @ApiProperty({ type: MoneyDto, example: { amount: "975.00", currency: "BRL" } }) calculatedBalance!: MoneyDto;
  @ApiProperty({ type: MoneyDto, example: { amount: "0.00", currency: "BRL" } }) difference!: MoneyDto;
  @ApiProperty({ type: Boolean, example: true }) consistent!: boolean;
  @ApiProperty({ type: Number, example: 42 }) checkedEntries!: number;
}

// ---------------------------------------------------------------- wagering

const KINDS = ["BET", "WIN", "LOSS", "REFUND", "ROLLBACK"];
const STATUSES = ["PENDING", "PENDING_REFERENCE", "PROCESSED", "REJECTED", "FAILED"];
const FAILURE_CODES = [
  "INSUFFICIENT_FUNDS",
  "REVERSAL_INSUFFICIENT_FUNDS",
  "WALLET_NOT_FOUND",
  "WALLET_PLAYER_MISMATCH",
  "CURRENCY_MISMATCH",
  "REFERENCE_NOT_FOUND",
  "REFERENCE_MISMATCH",
  "REFERENCE_KIND_NOT_ALLOWED",
  "REFERENCE_NOT_PROCESSED",
  "REFERENCE_ALREADY_REVERSED",
  "REFERENCE_AMOUNT_MISMATCH",
  "PERMANENT_PROCESSING_ERROR",
];

export class SubmitWagerRequest {
  @ApiProperty({ type: String, example: "provider-a" }) providerId!: string;
  @ApiProperty({ type: String, example: "transaction-123" }) externalTransactionId!: string;
  @ApiProperty({ type: String, format: "uuid", example: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1" }) playerId!: string;
  @ApiProperty({ type: String, format: "uuid", example: "0192f291-27dd-7d3f-8071-5f8685deef37" }) walletId!: string;
  @ApiProperty({ type: String, example: "round-987" }) roundId!: string;
  @ApiProperty({ type: String, example: "fortune-chimp" }) gameId!: string;

  @ApiProperty({
    type: String,
    enum: KINDS,
    example: "BET",
    description: "BET debits · WIN credits · LOSS records only · REFUND/ROLLBACK reverse a referenced transaction",
  })
  kind!: string;

  @ApiProperty({ type: MoneyDto, example: { amount: "25.00", currency: "BRL" } }) money!: MoneyDto;

  @ApiPropertyOptional({
    type: String,
    example: "transaction-122",
    description: "Provider id of the referenced transaction. Required for REFUND and ROLLBACK; optional for WIN.",
  })
  referenceExternalTransactionId?: string;
}

export class SubmitWagerResponse {
  @ApiProperty({ type: String, format: "uuid", example: "0192f298-345e-7e38-af88-e43f851a819d" }) transactionId!: string;
  @ApiProperty({ type: String, enum: STATUSES, example: "PROCESSED" }) status!: string;

  @ApiPropertyOptional({
    type: MoneyDto,
    example: { amount: "975.00", currency: "BRL" },
    description: "Balance observed when the transaction was decided (identical on replays)",
  })
  balance?: MoneyDto;

  @ApiPropertyOptional({ type: String, enum: FAILURE_CODES, description: "Present when status is REJECTED/FAILED" })
  failureCode?: string;

  @ApiProperty({ type: Boolean, example: false }) idempotentReplay!: boolean;
}

export class TransactionResponse {
  @ApiProperty({ type: String, format: "uuid" }) id!: string;
  @ApiProperty({ type: String, example: "provider-a" }) providerId!: string;
  @ApiProperty({ type: String, example: "transaction-123" }) externalTransactionId!: string;
  @ApiProperty({ type: String, format: "uuid" }) walletId!: string;
  @ApiProperty({ type: String, format: "uuid" }) playerId!: string;
  @ApiProperty({ type: String, example: "round-987" }) roundId!: string;
  @ApiProperty({ type: String, example: "fortune-chimp" }) gameId!: string;
  @ApiProperty({ type: String, enum: [...KINDS, "OPENING"], example: "BET" }) kind!: string;
  @ApiProperty({ type: MoneyDto, example: { amount: "25.00", currency: "BRL" } }) money!: MoneyDto;
  @ApiProperty({ type: String, enum: STATUSES, example: "PROCESSED" }) status!: string;
  @ApiPropertyOptional({ type: String }) referenceExternalTransactionId?: string;
  @ApiPropertyOptional({ type: String, format: "uuid" }) referenceTransactionId?: string;
  @ApiPropertyOptional({ type: String, enum: FAILURE_CODES }) failureCode?: string;
  @ApiPropertyOptional({ type: MoneyDto, example: { amount: "975.00", currency: "BRL" } }) balance?: MoneyDto;
  @ApiProperty({ type: String, format: "date-time" }) createdAt!: string;
  @ApiPropertyOptional({ type: String, format: "date-time" }) processedAt?: string;
}

// ---------------------------------------------------------------- errors

class ErrorDetail {
  @ApiProperty({
    type: String,
    example: "INVALID_PAYLOAD",
    description:
      "INVALID_PAYLOAD · INVALID_JSON · NOT_FOUND · IDEMPOTENCY_CONFLICT · WALLET_ALREADY_EXISTS · " +
      "TRANSIENT_INFRASTRUCTURE_ERROR · PERMANENT_PROCESSING_ERROR · PROVIDER_MISMATCH · INTERNAL_ERROR",
  })
  code!: string;

  @ApiProperty({ type: String, example: "Invalid wager transaction payload" }) message!: string;

  @ApiPropertyOptional({ type: Object, example: { fields: { money: "amount must be a decimal string" } } })
  details?: Record<string, unknown>;
}

export class ErrorResponse {
  @ApiProperty({ type: ErrorDetail }) error!: ErrorDetail;
  @ApiProperty({ type: String, example: "0192f2a0-0000-7000-8000-000000000000" }) correlationId!: string;
}

// ---------------------------------------------------------------- health

class DependencyStatusDto {
  @ApiProperty({ type: String, enum: ["up", "down"] }) status!: string;
  @ApiProperty({ type: Number, example: 4 }) latencyMs!: number;
  @ApiPropertyOptional({ type: String }) error?: string;
}

export class ReadinessResponse {
  @ApiProperty({ type: String, enum: ["ready", "not_ready"] }) status!: string;

  @ApiProperty({
    type: Object,
    additionalProperties: { $ref: "#/components/schemas/DependencyStatusDto" },
    example: { postgres: { status: "up", latencyMs: 4 }, sqs: { status: "up", latencyMs: 7 } },
  })
  checks!: Record<string, DependencyStatusDto>;
}

export const EXTRA_MODELS = [DependencyStatusDto];
