/**
 * Stable, machine-readable reasons a transaction ended REJECTED or FAILED.
 * Providers branch on these, so values are part of the public contract: never rename.
 *
 * Retry guidance for the provider:
 *  - FIX_PAYLOAD : the request itself is wrong — correct it and send with a NEW external id.
 *  - GIVE_UP     : the request was valid but the business state forbids it.
 *  - CONTACT     : permanent infrastructure failure; operator investigation needed.
 */
export enum FailureCode {
  // ---- business: balance
  InsufficientFunds = "INSUFFICIENT_FUNDS", // BET larger than balance            (GIVE_UP)
  ReversalInsufficientFunds = "REVERSAL_INSUFFICIENT_FUNDS", // reversal would go negative (GIVE_UP, audit)

  // ---- business: wallet / identity
  WalletNotFound = "WALLET_NOT_FOUND", // (FIX_PAYLOAD)
  WalletPlayerMismatch = "WALLET_PLAYER_MISMATCH", // walletId does not belong to playerId (FIX_PAYLOAD)
  CurrencyMismatch = "CURRENCY_MISMATCH", // operation currency != wallet currency (FIX_PAYLOAD)

  // ---- business: references (REFUND / ROLLBACK / WIN)
  ReferenceNotFound = "REFERENCE_NOT_FOUND", // referenced tx never arrived within the TTL (GIVE_UP)
  ReferenceMismatch = "REFERENCE_MISMATCH", // different player/wallet/currency/round (FIX_PAYLOAD)
  ReferenceKindNotAllowed = "REFERENCE_KIND_NOT_ALLOWED", // e.g. REFUND of a WIN   (FIX_PAYLOAD)
  ReferenceNotProcessed = "REFERENCE_NOT_PROCESSED", // reference ended REJECTED/FAILED (GIVE_UP)
  ReferenceAlreadyReversed = "REFERENCE_ALREADY_REVERSED", // second reversal of the same tx (GIVE_UP)
  ReferenceAmountMismatch = "REFERENCE_AMOUNT_MISMATCH", // partial reversal not supported (FIX_PAYLOAD)

  // ---- infrastructure (FAILED)
  PermanentProcessingError = "PERMANENT_PROCESSING_ERROR", // (CONTACT)
}
