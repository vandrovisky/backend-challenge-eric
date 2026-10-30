import { Body, Controller, Get, Headers, HttpStatus, Inject, Param, Post, Req, Res, UseGuards } from "@nestjs/common";
import {
  ApiBody,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import type { Response } from "express";
import { PayloadValidationError } from "../../application/errors";
import type { SubmitWagerResult } from "../../application/wagering/submit-wager-transaction";
import type { SubmitWagerCommand } from "../../application/wagering/wager-command";
import type { Core } from "../../composition-root";
import { WagerTransactionStatus } from "../../domain/wagering/wager-transaction";
import { assertActsAsSelf, ProviderAuthGuard, type AuthenticatedRequest } from "./auth";
import { correlationIdOf } from "./correlation";
import { ErrorResponse, SubmitWagerRequest, SubmitWagerResponse, TransactionResponse } from "./openapi/schemas";
import { CORE } from "./tokens";

/**
 * Status of a submission, chosen so a provider can decide what to do from the code alone:
 *   201 PROCESSED (first time)        200 PROCESSED (idempotent replay)
 *   202 PENDING_REFERENCE (accepted, will be applied when the reference arrives)
 *   422 REJECTED (business rule — final; body.failureCode says why)
 *   500 FAILED (permanent processing error — final, recorded)
 * Errors (400/409/503) come from the ErrorFilter.
 */
export function submitStatus(result: SubmitWagerResult): number {
  switch (result.status) {
    case WagerTransactionStatus.Processed:
      return result.idempotentReplay ? HttpStatus.OK : HttpStatus.CREATED;
    case WagerTransactionStatus.Pending:
    case WagerTransactionStatus.PendingReference:
      return HttpStatus.ACCEPTED;
    case WagerTransactionStatus.Rejected:
      return HttpStatus.UNPROCESSABLE_ENTITY;
    case WagerTransactionStatus.Failed:
      return HttpStatus.INTERNAL_SERVER_ERROR;
  }
}

@ApiTags("wagering")
@Controller()
@UseGuards(ProviderAuthGuard)
export class WageringController {
  constructor(@Inject(CORE) private readonly core: Core) {}

  @Post("wagering/transactions")
  @ApiOperation({
    summary: "Submit a provider operation (BET, WIN, LOSS, REFUND, ROLLBACK)",
    description:
      "Idempotent: resending the same body with the same Idempotency-Key returns the original result " +
      "(200 + header Idempotent-Replayed). Same key with a different body is a 409.",
  })
  @ApiHeader({
    name: "Idempotency-Key",
    required: true,
    description: "Source of truth for idempotency. Recommended: {providerId}:{externalTransactionId}",
    example: "provider-a:transaction-123",
  })
  @ApiHeader({ name: "X-Correlation-Id", required: false, description: "Echoed back; generated if absent" })
  @ApiBody({
    type: SubmitWagerRequest,
    examples: {
      bet: {
        summary: "BET 25.00",
        value: {
          providerId: "provider-a",
          externalTransactionId: "transaction-123",
          playerId: "<playerId>",
          walletId: "<walletId>",
          roundId: "round-987",
          gameId: "fortune-chimp",
          kind: "BET",
          money: { amount: "25.00", currency: "BRL" },
        },
      },
      win: {
        summary: "WIN 50.00 referencing the BET",
        value: {
          providerId: "provider-a",
          externalTransactionId: "transaction-124",
          playerId: "<playerId>",
          walletId: "<walletId>",
          roundId: "round-987",
          gameId: "fortune-chimp",
          kind: "WIN",
          money: { amount: "50.00", currency: "BRL" },
          referenceExternalTransactionId: "transaction-123",
        },
      },
      refund: {
        summary: "REFUND of the BET (same amount)",
        value: {
          providerId: "provider-a",
          externalTransactionId: "transaction-125",
          playerId: "<playerId>",
          walletId: "<walletId>",
          roundId: "round-987",
          gameId: "fortune-chimp",
          kind: "REFUND",
          money: { amount: "25.00", currency: "BRL" },
          referenceExternalTransactionId: "transaction-123",
        },
      },
      loss: {
        summary: "LOSS (no balance change)",
        value: {
          providerId: "provider-a",
          externalTransactionId: "transaction-126",
          playerId: "<playerId>",
          walletId: "<walletId>",
          roundId: "round-987",
          gameId: "fortune-chimp",
          kind: "LOSS",
          money: { amount: "0.00", currency: "BRL" },
        },
      },
    },
  })
  @ApiResponse({ status: 201, description: "PROCESSED now", type: SubmitWagerResponse })
  @ApiResponse({ status: 200, description: "Idempotent replay (identical body)", type: SubmitWagerResponse })
  @ApiResponse({ status: 202, description: "PENDING_REFERENCE: waiting for the referenced transaction", type: SubmitWagerResponse })
  @ApiResponse({ status: 422, description: "REJECTED by a business rule (see failureCode)", type: SubmitWagerResponse })
  @ApiResponse({ status: 400, description: "Invalid payload / missing Idempotency-Key", type: ErrorResponse })
  @ApiResponse({ status: 409, description: "Idempotency conflict", type: ErrorResponse })
  @ApiResponse({ status: 503, description: "Transient failure — safe to retry as-is (Retry-After)", type: ErrorResponse })
  @ApiResponse({ status: 500, description: "FAILED (permanent, recorded)", type: ErrorResponse })
  async submit(
    @Body() body: Record<string, unknown> | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!idempotencyKey) {
      throw new PayloadValidationError("Idempotency-Key header is required", {
        fields: { "Idempotency-Key": "required" },
      });
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new PayloadValidationError("Body must be a JSON object");
    }
    assertActsAsSelf(req, body.providerId);

    const command: SubmitWagerCommand = {
      idempotencyKey,
      providerId: body.providerId,
      externalTransactionId: body.externalTransactionId,
      playerId: body.playerId,
      walletId: body.walletId,
      roundId: body.roundId,
      gameId: body.gameId,
      kind: body.kind,
      money: body.money,
      referenceExternalTransactionId: body.referenceExternalTransactionId,
    };
    const result = await this.core.submitWager.execute(command, { correlationId: correlationIdOf(req) });
    res.status(submitStatus(result));
    if (result.idempotentReplay) res.setHeader("Idempotent-Replayed", "true");
    return result;
  }

  @Get("wagering/transactions/:transactionId")
  @ApiOperation({ summary: "Transaction by internal id" })
  @ApiParam({ name: "transactionId", format: "uuid" })
  @ApiResponse({ status: 200, type: TransactionResponse })
  @ApiResponse({ status: 404, type: ErrorResponse })
  getById(@Param("transactionId") transactionId: string) {
    return this.core.queries.getTransaction(transactionId);
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  @ApiOperation({ summary: "Transaction by the provider's own id" })
  @ApiParam({ name: "providerId", example: "provider-a" })
  @ApiParam({ name: "externalTransactionId", example: "transaction-123" })
  @ApiResponse({ status: 200, type: TransactionResponse })
  @ApiResponse({ status: 404, type: ErrorResponse })
  getByExternalId(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    assertActsAsSelf(req, providerId);
    return this.core.queries.getTransactionByExternalId(providerId, externalTransactionId);
  }
}
