import { InvalidTransactionStateError, ValidationError } from "../shared/domain-error";
import type { Money } from "../shared/money";
import { LedgerDirection } from "../wallet/wallet-ledger-entry";
import type { FailureCode } from "./failure-code";

export enum WagerTransactionKind {
  Opening = "OPENING", // internal: wallet opening credit
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
  Pending = "PENDING",
  PendingReference = "PENDING_REFERENCE",
  Processed = "PROCESSED",
  Rejected = "REJECTED",
  Failed = "FAILED",
}

/** Kinds a provider may submit (API or queue). OPENING is internal only. */
export const SUBMITTABLE_KINDS: readonly WagerTransactionKind[] = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
];

/** Which kinds each referencing kind may point at. */
const ALLOWED_REFERENCE_KINDS: Partial<Record<WagerTransactionKind, readonly WagerTransactionKind[]>> = {
  [WagerTransactionKind.Win]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ],
};

const TERMINAL: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  /** Balance observed right after this transaction was applied/decided (for faithful replays). */
  resultingBalance?: Money;
  referenceAttempts: number;
  nextReferenceCheckAt?: Date;
}

/**
 * A provider operation on a wallet.
 *
 * State machine (anything else throws InvalidTransactionStateError):
 *
 *   PENDING ──► PROCESSED | REJECTED | FAILED          (terminal)
 *      │
 *      └──► PENDING_REFERENCE ──► PROCESSED | REJECTED | FAILED
 *                 ▲      │
 *                 └──────┘  (re-scheduled while the reference is still missing)
 */
export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** id at the provider — not the internal id */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    private _processedAt: Date | undefined,
    private _resultingBalance: Money | undefined,
    private _referenceAttempts: number,
    private _nextReferenceCheckAt: Date | undefined,
  ) {}

  /** Born PENDING. Validates per-kind shape (reference requirement, amount sign). */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (!SUBMITTABLE_KINDS.includes(props.kind)) {
      throw new ValidationError(`kind ${props.kind} cannot be submitted`);
    }
    return WagerTransaction.build(props);
  }

  /** Internal OPENING credit created together with a wallet. */
  static opening(props: {
    id: string;
    walletId: string;
    playerId: string;
    money: Money;
    at: Date;
  }): WagerTransaction {
    return WagerTransaction.build({
      id: props.id,
      providerId: "internal",
      externalTransactionId: `opening:${props.walletId}`,
      idempotencyKey: `internal:opening:${props.walletId}`,
      payloadHash: "opening",
      walletId: props.walletId,
      playerId: props.playerId,
      roundId: "opening",
      gameId: "internal",
      kind: WagerTransactionKind.Opening,
      money: props.money,
      createdAt: props.at,
    });
  }

  private static build(props: CreateWagerTransactionProps): WagerTransaction {
    const tx = new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId || undefined,
      new Date(props.createdAt),
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
    );
    if (tx.requiresReference() && !tx.referenceExternalTransactionId) {
      throw new ValidationError(`${tx.kind} requires referenceExternalTransactionId`);
    }
    if (tx.referenceExternalTransactionId && !ALLOWED_REFERENCE_KINDS[tx.kind]) {
      throw new ValidationError(`${tx.kind} must not carry a reference`);
    }
    if (tx.referenceExternalTransactionId === tx.externalTransactionId) {
      throw new ValidationError("A transaction cannot reference itself");
    }
    if (tx.affectsBalance() ? !tx.money.isPositive() : tx.money.isNegative()) {
      throw new ValidationError(`${tx.kind} amount must be ${tx.affectsBalance() ? "positive" : "zero or positive"}`);
    }
    return tx;
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId || undefined,
      new Date(state.createdAt),
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt && new Date(state.processedAt),
      state.resultingBalance,
      state.referenceAttempts,
      state.nextReferenceCheckAt && new Date(state.nextReferenceCheckAt),
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  get resultingBalance(): Money | undefined {
    return this._resultingBalance;
  }
  get referenceAttempts(): number {
    return this._referenceAttempts;
  }
  get nextReferenceCheckAt(): Date | undefined {
    return this._nextReferenceCheckAt;
  }

  // ---- transitions

  markProcessed(referenceTransactionId: string | undefined, resultingBalance: Money, at: Date): void {
    this.assertNotTerminal("markProcessed");
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._resultingBalance = resultingBalance;
    this._processedAt = new Date(at);
    this._nextReferenceCheckAt = undefined;
  }

  /** Parks the transaction until its reference shows up; schedules the next check. */
  markPendingReference(nextCheckAt: Date): void {
    this.assertNotTerminal("markPendingReference");
    if (this._status === WagerTransactionStatus.PendingReference) this._referenceAttempts += 1;
    this._status = WagerTransactionStatus.PendingReference;
    this._nextReferenceCheckAt = new Date(nextCheckAt);
  }

  reject(code: FailureCode, observedBalance: Money | undefined, at: Date): void {
    this.assertNotTerminal("reject");
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._resultingBalance = observedBalance;
    this._processedAt = new Date(at);
    this._nextReferenceCheckAt = undefined;
  }

  fail(code: FailureCode, at: Date): void {
    this.assertNotTerminal("fail");
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = new Date(at);
    this._nextReferenceCheckAt = undefined;
  }

  // ---- domain queries

  isTerminal(): boolean {
    return TERMINAL.has(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  isReversal(): boolean {
    return this.requiresReference();
  }

  hasReference(): boolean {
    return this.referenceExternalTransactionId !== undefined;
  }

  canReference(reference: WagerTransaction): boolean {
    return ALLOWED_REFERENCE_KINDS[this.kind]?.includes(reference.kind) ?? false;
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * BET debits; WIN/REFUND/OPENING credit; ROLLBACK inverts the referenced transaction.
   * LOSS has no direction (never touches the balance).
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
      case WagerTransactionKind.Opening:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) throw new InvalidTransactionStateError("ROLLBACK direction needs the reference");
        const original = reference.ledgerDirectionFor();
        return original === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvalidTransactionStateError("LOSS does not produce ledger entries");
    }
  }

  private assertNotTerminal(transition: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(
        `Cannot ${transition}: transaction ${this.id} is already ${this._status}`,
      );
    }
  }
}
