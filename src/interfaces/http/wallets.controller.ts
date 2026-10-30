import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { ApiBody, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import { PayloadValidationError } from "../../application/errors";
import type { Core } from "../../composition-root";
import { ProviderAuthGuard } from "./auth";
import { correlationIdOf } from "./correlation";
import {
  CreateWalletRequest,
  ErrorResponse,
  LedgerPageResponse,
  ReconciliationResponse,
  WalletResponse,
} from "./openapi/schemas";
import { CORE } from "./tokens";

@ApiTags("wallets")
@Controller("wallets")
@UseGuards(ProviderAuthGuard)
export class WalletsController {
  constructor(@Inject(CORE) private readonly core: Core) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: "Create a wallet",
    description: "A positive initial balance creates an internal OPENING transaction and its CREDIT ledger entry in the same commit.",
  })
  @ApiBody({ type: CreateWalletRequest })
  @ApiResponse({ status: 201, type: WalletResponse })
  @ApiResponse({ status: 400, type: ErrorResponse })
  @ApiResponse({ status: 409, description: "A wallet for this player and currency already exists", type: ErrorResponse })
  create(@Body() body: Record<string, unknown> | undefined, @Req() req: Request) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new PayloadValidationError("Body must be a JSON object");
    }
    return this.core.openWallet.execute(
      { playerId: body.playerId, initialBalance: body.initialBalance },
      { correlationId: correlationIdOf(req) },
    );
  }

  @Get(":walletId")
  @ApiOperation({ summary: "Wallet balance and version" })
  @ApiParam({ name: "walletId", format: "uuid" })
  @ApiResponse({ status: 200, type: WalletResponse })
  @ApiResponse({ status: 404, type: ErrorResponse })
  get(@Param("walletId") walletId: string) {
    return this.core.queries.getWallet(walletId);
  }

  @Get(":walletId/ledger")
  @ApiOperation({ summary: "Ledger entries, oldest first, with a stable opaque cursor" })
  @ApiParam({ name: "walletId", format: "uuid" })
  @ApiQuery({ name: "cursor", required: false, description: "nextCursor from the previous page" })
  @ApiQuery({ name: "limit", required: false, schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } })
  @ApiResponse({ status: 200, type: LedgerPageResponse })
  @ApiResponse({ status: 400, type: ErrorResponse })
  @ApiResponse({ status: 404, type: ErrorResponse })
  ledger(
    @Param("walletId") walletId: string,
    @Query("cursor") cursor: string | undefined,
    @Query("limit") limit: string | undefined,
  ) {
    return this.core.queries.getLedger(walletId, cursor, limit);
  }

  /** 200 in both cases: a divergence is a finding of the check, signalled by `consistent: false`. */
  @Post(":walletId/reconciliation")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Compare the stored balance with the balance rebuilt from the ledger",
    description: "Divergences are never corrected: they are logged, counted and reported with consistent=false.",
  })
  @ApiParam({ name: "walletId", format: "uuid" })
  @ApiResponse({ status: 200, type: ReconciliationResponse })
  @ApiResponse({ status: 404, type: ErrorResponse })
  reconcile(@Param("walletId") walletId: string, @Req() req: Request) {
    return this.core.queries.reconcile(walletId, { correlationId: correlationIdOf(req) });
  }
}
