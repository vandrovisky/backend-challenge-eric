import { Migration } from "@mikro-orm/migrations";

/**
 * Initial schema. Every guarantee of uniqueness, immutability and non-negativity lives here,
 * in the database — application code is a second line of defence, not the only one.
 *
 * Money: numeric(20,2) + char(3) currency. numeric is exact decimal; scale 2 matches Money.
 */
export class Migration20261028000001_initial_schema extends Migration {
  override name = "Migration20261028000001_initial_schema";

  override up(): void {
    for (const sql of UP) this.addSql(sql);
  }

  override down(): void {
    for (const sql of DOWN) this.addSql(sql);
  }
}

const CURRENCY = `char(3) NOT NULL CHECK (%s ~ '^[A-Z]{3}$')`;
const currency = (col: string) => `${col} ${CURRENCY.replace("%s", col)}`;

const UP: string[] = [
  // ---------------------------------------------------------------- wallets
  `CREATE TABLE wallets (
    id          uuid PRIMARY KEY,
    player_id   uuid NOT NULL,
    ${currency("currency")},
    balance     numeric(20,2) NOT NULL CHECK (balance >= 0),
    version     integer NOT NULL CHECK (version >= 1),
    created_at  timestamptz NOT NULL,
    updated_at  timestamptz NOT NULL,
    CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency),
    -- target of the composite FK from the ledger: guarantees entry currency == wallet currency
    CONSTRAINT uq_wallets_id_currency UNIQUE (id, currency)
  )`,

  // ---------------------------------------------------------------- wager_transactions
  `CREATE TABLE wager_transactions (
    id                                 uuid PRIMARY KEY,
    provider_id                        varchar(128) NOT NULL CHECK (length(provider_id) > 0),
    external_transaction_id            varchar(255) NOT NULL CHECK (length(external_transaction_id) > 0),
    idempotency_key                    varchar(512) NOT NULL CHECK (length(idempotency_key) > 0),
    payload_hash                       varchar(100) NOT NULL,
    wallet_id                          uuid NOT NULL,  -- no FK: a tx for an unknown wallet is persisted as REJECTED
    player_id                          uuid NOT NULL,
    round_id                           varchar(255) NOT NULL,
    game_id                            varchar(255) NOT NULL,
    kind                               varchar(16) NOT NULL
      CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
    amount                             numeric(20,2) NOT NULL CHECK (amount >= 0),
    ${currency("currency")},
    reference_external_transaction_id  varchar(255),
    reference_transaction_id           uuid REFERENCES wager_transactions(id),
    status                             varchar(20) NOT NULL
      CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
    failure_code                       varchar(64),
    resulting_balance                  numeric(20,2) CHECK (resulting_balance >= 0),
    reference_attempts                 integer NOT NULL DEFAULT 0 CHECK (reference_attempts >= 0),
    next_reference_check_at            timestamptz,
    created_at                         timestamptz NOT NULL,
    updated_at                         timestamptz NOT NULL,
    processed_at                       timestamptz,

    CONSTRAINT uq_wager_tx_idempotency_key UNIQUE (idempotency_key),
    CONSTRAINT uq_wager_tx_provider_external UNIQUE (provider_id, external_transaction_id),
    -- target of the composite FK from the ledger: entry wallet == transaction wallet
    CONSTRAINT uq_wager_tx_id_wallet UNIQUE (id, wallet_id),

    CONSTRAINT ck_wager_tx_reference_required
      CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
    CONSTRAINT ck_wager_tx_reference_forbidden
      CHECK (kind NOT IN ('BET','LOSS','OPENING') OR reference_external_transaction_id IS NULL),
    CONSTRAINT ck_wager_tx_opening_internal
      CHECK ((kind = 'OPENING') = (provider_id = 'internal')),
    CONSTRAINT ck_wager_tx_positive_amount
      CHECK (kind = 'LOSS' OR amount > 0),
    CONSTRAINT ck_wager_tx_status_fields CHECK (
      CASE status
        WHEN 'PROCESSED' THEN processed_at IS NOT NULL AND failure_code IS NULL AND resulting_balance IS NOT NULL
        WHEN 'REJECTED'  THEN processed_at IS NOT NULL AND failure_code IS NOT NULL
        WHEN 'FAILED'    THEN processed_at IS NOT NULL AND failure_code IS NOT NULL
        WHEN 'PENDING_REFERENCE' THEN processed_at IS NULL AND failure_code IS NULL AND next_reference_check_at IS NOT NULL
        ELSE processed_at IS NULL AND failure_code IS NULL
      END),
    CONSTRAINT ck_wager_tx_processed_reversal_linked
      CHECK (status <> 'PROCESSED' OR kind NOT IN ('REFUND','ROLLBACK') OR reference_transaction_id IS NOT NULL)
  )`,

  // A transaction can be reversed (REFUND or ROLLBACK) at most once.
  `CREATE UNIQUE INDEX uq_wager_tx_single_reversal
     ON wager_transactions (reference_transaction_id)
     WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED'`,

  // Scheduler scan for parked transactions.
  `CREATE INDEX ix_wager_tx_pending_reference_due
     ON wager_transactions (next_reference_check_at)
     WHERE status = 'PENDING_REFERENCE'`,

  // Wake dependents as soon as their reference arrives.
  `CREATE INDEX ix_wager_tx_pending_by_reference
     ON wager_transactions (provider_id, reference_external_transaction_id)
     WHERE status = 'PENDING_REFERENCE'`,

  `CREATE INDEX ix_wager_tx_wallet ON wager_transactions (wallet_id, created_at)`,

  // ---------------------------------------------------------------- wallet_ledger_entries
  `CREATE TABLE wallet_ledger_entries (
    id              uuid PRIMARY KEY,
    wallet_id       uuid NOT NULL,
    transaction_id  uuid NOT NULL,
    direction       varchar(6) NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
    amount          numeric(20,2) NOT NULL CHECK (amount > 0),
    ${currency("currency")},
    balance_before  numeric(20,2) NOT NULL CHECK (balance_before >= 0),
    balance_after   numeric(20,2) NOT NULL CHECK (balance_after >= 0),
    wallet_version  integer NOT NULL CHECK (wallet_version >= 1),
    created_at      timestamptz NOT NULL,

    CONSTRAINT fk_ledger_wallet_currency FOREIGN KEY (wallet_id, currency)
      REFERENCES wallets (id, currency),
    CONSTRAINT fk_ledger_transaction_wallet FOREIGN KEY (transaction_id, wallet_id)
      REFERENCES wager_transactions (id, wallet_id),
    -- at most one entry per transaction per wallet
    CONSTRAINT uq_ledger_transaction_wallet UNIQUE (transaction_id, wallet_id),
    -- one entry per wallet version: two concurrent writers can never both produce version N
    CONSTRAINT uq_ledger_wallet_version UNIQUE (wallet_id, wallet_version),
    CONSTRAINT ck_ledger_balanced CHECK (
      balance_after = CASE direction WHEN 'CREDIT' THEN balance_before + amount
                                     ELSE balance_before - amount END)
  )`,

  // Ledger is append-only.
  `CREATE FUNCTION ledger_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     RAISE EXCEPTION 'wallet_ledger_entries is append-only (% forbidden)', TG_OP
       USING ERRCODE = 'restrict_violation';
   END $$`,
  `CREATE TRIGGER trg_ledger_no_update_delete
     BEFORE UPDATE OR DELETE ON wallet_ledger_entries
     FOR EACH ROW EXECUTE FUNCTION ledger_forbid_mutation()`,
  `CREATE TRIGGER trg_ledger_no_truncate
     BEFORE TRUNCATE ON wallet_ledger_entries
     FOR EACH STATEMENT EXECUTE FUNCTION ledger_forbid_mutation()`,

  // Ledger chain: each entry starts where the previous one ended.
  `CREATE FUNCTION ledger_check_chain() RETURNS trigger LANGUAGE plpgsql AS $$
   DECLARE prev_after numeric(20,2);
   BEGIN
     SELECT balance_after INTO prev_after FROM wallet_ledger_entries
      WHERE wallet_id = NEW.wallet_id AND wallet_version = NEW.wallet_version - 1;
     IF NOT FOUND THEN
       -- first movement: either the opening credit (v1) or the first one after a zero opening (v2)
       IF NEW.wallet_version > 2 OR NEW.balance_before <> 0 THEN
         RAISE EXCEPTION 'ledger chain broken for wallet % at version %', NEW.wallet_id, NEW.wallet_version
           USING ERRCODE = 'check_violation';
       END IF;
     ELSIF prev_after <> NEW.balance_before THEN
       RAISE EXCEPTION 'ledger chain broken for wallet % at version %', NEW.wallet_id, NEW.wallet_version
         USING ERRCODE = 'check_violation';
     END IF;
     RETURN NEW;
   END $$`,
  `CREATE TRIGGER trg_ledger_chain BEFORE INSERT ON wallet_ledger_entries
     FOR EACH ROW EXECUTE FUNCTION ledger_check_chain()`,

  // Wallet: identity is immutable, version moves iff balance moves, never deleted.
  `CREATE FUNCTION wallet_guard() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     IF TG_OP = 'DELETE' THEN
       RAISE EXCEPTION 'wallets cannot be deleted' USING ERRCODE = 'restrict_violation';
     END IF;
     IF TG_OP = 'INSERT' THEN
       IF NEW.version <> 1 THEN
         RAISE EXCEPTION 'wallet must be created at version 1' USING ERRCODE = 'check_violation';
       END IF;
       RETURN NEW;
     END IF;
     IF NEW.id <> OLD.id OR NEW.player_id <> OLD.player_id OR NEW.currency <> OLD.currency
        OR NEW.created_at <> OLD.created_at THEN
       RAISE EXCEPTION 'wallet identity is immutable' USING ERRCODE = 'restrict_violation';
     END IF;
     IF NEW.balance <> OLD.balance AND NEW.version <> OLD.version + 1 THEN
       RAISE EXCEPTION 'wallet version must increment by 1 when balance changes' USING ERRCODE = 'check_violation';
     END IF;
     IF NEW.balance = OLD.balance AND NEW.version <> OLD.version THEN
       RAISE EXCEPTION 'wallet version must not change without a balance change' USING ERRCODE = 'check_violation';
     END IF;
     RETURN NEW;
   END $$`,
  `CREATE TRIGGER trg_wallet_guard BEFORE INSERT OR UPDATE OR DELETE ON wallets
     FOR EACH ROW EXECUTE FUNCTION wallet_guard()`,

  // Every balance state must be backed by the ledger entry that produced it.
  // DEFERRED: checked at COMMIT, so the order of INSERT/UPDATE inside the transaction does not matter.
  `CREATE FUNCTION wallet_balance_backed_by_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     IF TG_OP = 'INSERT' AND NEW.balance = 0 THEN
       RETURN NULL; -- zero opening: no entry needed
     END IF;
     IF TG_OP = 'UPDATE' AND NEW.version = OLD.version THEN
       RETURN NULL; -- balance unchanged (guaranteed by wallet_guard)
     END IF;
     PERFORM 1 FROM wallet_ledger_entries
       WHERE wallet_id = NEW.id AND wallet_version = NEW.version AND balance_after = NEW.balance;
     IF NOT FOUND THEN
       RAISE EXCEPTION 'wallet % balance % at version % has no matching ledger entry',
         NEW.id, NEW.balance, NEW.version USING ERRCODE = 'check_violation';
     END IF;
     RETURN NULL;
   END $$`,
  `CREATE CONSTRAINT TRIGGER trg_wallet_backed_by_ledger
     AFTER INSERT OR UPDATE ON wallets
     DEFERRABLE INITIALLY DEFERRED
     FOR EACH ROW EXECUTE FUNCTION wallet_balance_backed_by_ledger()`,

  // Wager transactions: business fields immutable, terminal states final, never deleted.
  `CREATE FUNCTION wager_tx_guard() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     IF TG_OP = 'DELETE' THEN
       RAISE EXCEPTION 'wager_transactions cannot be deleted' USING ERRCODE = 'restrict_violation';
     END IF;
     IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
       RAISE EXCEPTION 'transaction % is terminal (%)', OLD.id, OLD.status USING ERRCODE = 'restrict_violation';
     END IF;
     IF (NEW.id, NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key, NEW.payload_hash,
         NEW.wallet_id, NEW.player_id, NEW.round_id, NEW.game_id, NEW.kind, NEW.amount, NEW.currency,
         NEW.reference_external_transaction_id, NEW.created_at)
        IS DISTINCT FROM
        (OLD.id, OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key, OLD.payload_hash,
         OLD.wallet_id, OLD.player_id, OLD.round_id, OLD.game_id, OLD.kind, OLD.amount, OLD.currency,
         OLD.reference_external_transaction_id, OLD.created_at) THEN
       RAISE EXCEPTION 'transaction % business fields are immutable', OLD.id USING ERRCODE = 'restrict_violation';
     END IF;
     RETURN NEW;
   END $$`,
  `CREATE TRIGGER trg_wager_tx_guard BEFORE UPDATE OR DELETE ON wager_transactions
     FOR EACH ROW EXECUTE FUNCTION wager_tx_guard()`,

  // ---------------------------------------------------------------- inbox
  `CREATE TABLE inbox_messages (
    consumer_name   varchar(128) NOT NULL,
    message_id      varchar(255) NOT NULL,
    payload_hash    varchar(100) NOT NULL,
    transaction_id  uuid REFERENCES wager_transactions(id),
    received_at     timestamptz NOT NULL,
    processed_at    timestamptz,
    PRIMARY KEY (consumer_name, message_id)
  )`,

  // ---------------------------------------------------------------- outbox
  `CREATE TABLE outbox_messages (
    id               uuid PRIMARY KEY,           -- = eventId; consumers dedupe on it
    aggregate_id     uuid NOT NULL,
    event_type       varchar(100) NOT NULL,
    payload          jsonb NOT NULL,
    occurred_at      timestamptz NOT NULL,
    attempts         integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at  timestamptz,
    published_at     timestamptz,
    last_error       varchar(1000),
    CONSTRAINT ck_outbox_schedule CHECK (published_at IS NOT NULL OR next_attempt_at IS NOT NULL)
  )`,
  `CREATE INDEX ix_outbox_pending_due ON outbox_messages (next_attempt_at)
     WHERE published_at IS NULL`,
  `CREATE FUNCTION outbox_guard() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     IF (NEW.id, NEW.aggregate_id, NEW.event_type, NEW.payload, NEW.occurred_at)
        IS DISTINCT FROM (OLD.id, OLD.aggregate_id, OLD.event_type, OLD.payload, OLD.occurred_at) THEN
       RAISE EXCEPTION 'outbox event % is immutable', OLD.id USING ERRCODE = 'restrict_violation';
     END IF;
     IF OLD.published_at IS NOT NULL AND NEW.published_at IS DISTINCT FROM OLD.published_at THEN
       RAISE EXCEPTION 'outbox event % already published', OLD.id USING ERRCODE = 'restrict_violation';
     END IF;
     RETURN NEW;
   END $$`,
  `CREATE TRIGGER trg_outbox_guard BEFORE UPDATE ON outbox_messages
     FOR EACH ROW EXECUTE FUNCTION outbox_guard()`,
];

const DOWN: string[] = [
  `DROP TABLE IF EXISTS outbox_messages`,
  `DROP FUNCTION IF EXISTS outbox_guard()`,
  `DROP TABLE IF EXISTS inbox_messages`,
  `DROP TABLE IF EXISTS wallet_ledger_entries`,
  `DROP FUNCTION IF EXISTS ledger_forbid_mutation()`,
  `DROP FUNCTION IF EXISTS ledger_check_chain()`,
  `DROP TABLE IF EXISTS wager_transactions`,
  `DROP FUNCTION IF EXISTS wager_tx_guard()`,
  `DROP TABLE IF EXISTS wallets`,
  `DROP FUNCTION IF EXISTS wallet_guard()`,
  `DROP FUNCTION IF EXISTS wallet_balance_backed_by_ledger()`,
];
