# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`)
recebidas por HTTP e por SQS. A solução continua correta com mensagens **duplicadas**, **fora de ordem** e
processadas **simultaneamente por várias instâncias**.

- Decisões, trade-offs e limitações: **[`ARCHITECTURE.md`](ARCHITECTURE.md)**
- Resultados do teste de carga: **[`docs/LOAD_TEST.md`](docs/LOAD_TEST.md)**

**Stack**: Bun 1.4 · TypeScript strict · NestJS 12 · PostgreSQL 17 · MikroORM 7 · AWS SQS (LocalStack 4.0) ·
Docker Compose.

## Garantias, em uma frase cada

- Dinheiro é `Money` sobre decimal exato (string no contrato, `numeric(20,2)` no banco) — nunca `number`.
- Toda alteração de saldo tem lançamento no ledger, e o **próprio banco** recusa o commit se não tiver.
- Concorrência por **lock da linha da wallet** (`SELECT … FOR UPDATE`), com update condicional por versão e
  `UNIQUE (wallet_id, wallet_version)` como redes de segurança.
- Idempotência **persistente** (idempotency key + hash de JSON canônico; inbox por `(consumer, messageId)`).
- Inbox, transação, saldo, ledger e outbox no **mesmo commit**; eventos só saem pela outbox, depois do commit.
- Ledger append-only, saldo não negativo, unicidades e reversão única garantidos **no schema**.

## Pré-requisitos

- [Bun](https://bun.sh) 1.4+
- Docker + Docker Compose v2

## Subir tudo (3 instâncias)

```bash
bun install
bun run app:up        # postgres + localstack (filas) + migrations + 3 instâncias nas portas 3000, 3001, 3002
```

O serviço `migrate` aplica as migrations uma vez antes das réplicas. Cada instância roda HTTP + consumidor SQS +
relay da outbox + worker de referências pendentes.

```bash
curl -s localhost:3000/health/ready
bun run app:down      # derruba e apaga os volumes
```

## Desenvolvimento local (uma instância fora do Docker)

```bash
bun run infra:up      # só postgres + localstack
bun run db:migrate
bun run start         # http://localhost:3000  (PORT=3999 bun run start para outra porta)
```

## Comandos

| Comando | O que faz |
|---|---|
| `bun run app:up` / `app:down` | Sobe/derruba o ambiente completo com 3 instâncias |
| `bun run infra:up` / `infra:down` | Sobe/derruba só Postgres e LocalStack |
| `bun run db:migrate` | Aplica migrations |
| `bun run db:migrate:down` | Reverte a última migration |
| `bun run db:migrate:status` | Migrations executadas/pendentes |
| `bun run start` | Sobe uma instância (HTTP + workers) |
| `bun run queue:send -- --wallet <id> --player <id> [--kind BET] [--amount 10.00] [--count 1] [--ref <extId>] [--duplicate]` | Publica mensagens na fila de entrada (`--duplicate` envia cada uma 2×) |
| `bun run typecheck` | `tsc --noEmit` (strict) |
| `bun run test:unit` | Testes de unidade |
| `bun run test:integration` | Testes de integração (Postgres + LocalStack reais; inclui 3 processos reais) |
| `bun run test:all` | Unidade + integração |
| `bun run test:load` | Teste de carga (3 processos) → gera `docs/LOAD_TEST.md` |

> Os testes de integração **recriam o schema** (migrations `down` + `up`). Rode-os com `bun run infra:up` e com as
> instâncias do compose paradas (`docker compose --profile app stop app`).

## Exemplos

```bash
PLAYER=$(cat /proc/sys/kernel/random/uuid)

# criar wallet
curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d "{\"playerId\":\"$PLAYER\",\"initialBalance\":{\"amount\":\"1000.00\",\"currency\":\"BRL\"}}"
# → 201 {"id":"<WALLET>","playerId":"…","balance":{"amount":"1000.00","currency":"BRL"},"version":1}

# aposta (reenviar o mesmo comando devolve 200 + Idempotent-Replayed: true)
curl -s -i -X POST localhost:3001/wagering/transactions -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"transaction-123\",\"playerId\":\"$PLAYER\",
       \"walletId\":\"<WALLET>\",\"roundId\":\"round-987\",\"gameId\":\"fortune-chimp\",\"kind\":\"BET\",
       \"money\":{\"amount\":\"25.00\",\"currency\":\"BRL\"}}"
# → 201 {"transactionId":"…","status":"PROCESSED","balance":{"amount":"975.00","currency":"BRL"},"idempotentReplay":false}

curl -s localhost:3002/wallets/<WALLET>
curl -s "localhost:3000/wallets/<WALLET>/ledger?limit=50"          # { items, nextCursor }
curl -s -X POST localhost:3000/wallets/<WALLET>/reconciliation       # { storedBalance, calculatedBalance, consistent, … }
curl -s localhost:3000/providers/provider-a/wagering/transactions/transaction-123
curl -s localhost:3000/metrics

# pela fila: 30 apostas, cada mensagem entregue 2×
bun run queue:send -- --wallet <WALLET> --player $PLAYER --kind BET --amount 10.00 --count 30 --duplicate
```

## Swagger (testes rápidos pelo navegador)

Com uma instância rodando, abra **http://localhost:3000/docs** (ou 3001/3002). Cada endpoint tem exemplos prontos
(BET, WIN, REFUND, LOSS): clique em **Try it out**, ajuste e execute. Roteiro rápido:

1. `POST /wallets` → copie `id` e `playerId` da resposta;
2. `POST /wagering/transactions` → escolha o exemplo, troque `<walletId>`/`<playerId>`, preencha o header
   `Idempotency-Key` (ex.: `provider-a:transaction-123`) → **201**;
3. execute de novo igual → **200** com `idempotentReplay: true`; mude o valor mantendo a key → **409**;
4. `GET /wallets/{walletId}/ledger` e `POST /wallets/{walletId}/reconciliation`.

O documento OpenAPI fica em **`/docs-json`** (dá para importar no Postman/Insomnia). Desligue com
`SWAGGER_ENABLED=false`.

## Endpoints

| Método e rota | Descrição |
|---|---|
| `POST /wallets` | Cria wallet (saldo inicial > 0 gera transação `OPENING` + crédito no ledger, mesmo commit). Duplicada → 409 |
| `GET /wallets/:walletId` | Wallet |
| `GET /wallets/:walletId/ledger?cursor=&limit=` | Ledger paginado (cursor opaco e estável, `limit` 1–200) |
| `POST /wallets/:walletId/reconciliation` | Saldo materializado × saldo reconstruído pelo ledger |
| `POST /wagering/transactions` | Submete transação (header `Idempotency-Key` obrigatório) |
| `GET /wagering/transactions/:transactionId` | Transação por id interno |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | Transação pelo id do provedor |
| `GET /health/live`, `GET /health/ready` | Liveness / readiness (Postgres + SQS). Sem autenticação |
| `GET /metrics` | Métricas Prometheus |
| `GET /docs`, `GET /docs-json` | Swagger UI / documento OpenAPI 3 |

Status da submissão: **201** processada · **200** replay · **202** aguardando referência · **422** rejeitada
(`failureCode`) · **400** payload inválido · **409** conflito de idempotência · **503** falha transitória
(`Retry-After`) · **500** falha permanente. Detalhes em `ARCHITECTURE.md` §11.

## Mensagem SQS (`wager-transactions.fifo`)

```json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-07-29T15:00:00.000Z",
  "data": {
    "providerId": "provider-a", "externalTransactionId": "transaction-123",
    "idempotencyKey": "provider-a:transaction-123",
    "playerId": "…", "walletId": "…", "roundId": "round-987", "gameId": "fortune-chimp",
    "kind": "BET", "money": { "amount": "25.00", "currency": "BRL" }
  }
}
```

Use `walletId` como `MessageGroupId`. Erros permanentes vão para `wager-transactions-dlq.fifo` com o atributo
`failureReason`; eventos de integração são publicados em `wager-events.fifo`.

## Variáveis de ambiente

| Variável | Padrão | |
|---|---|---|
| `PORT` | `3000` | Porta HTTP |
| `DATABASE_URL` | `postgres://wagering:wagering@localhost:5432/wagering` | |
| `DB_POOL_MAX` | `10` | Conexões por instância |
| `DB_LOCK_TIMEOUT_MS` | `5000` | Espera máxima pelo lock da wallet (depois: 503 / retry) |
| `DB_STATEMENT_TIMEOUT_MS` | `15000` | |
| `SQS_ENDPOINT` | `http://localhost:4566` | LocalStack |
| `AWS_REGION` | `us-east-1` | |
| `SQS_INPUT_QUEUE` / `SQS_DLQ` / `SQS_EVENTS_QUEUE` | `wager-transactions.fifo` / `wager-transactions-dlq.fifo` / `wager-events.fifo` | |
| `SQS_VISIBILITY_TIMEOUT_SECONDS` | `30` | |
| `SQS_WAIT_TIME_SECONDS` | `5` | Long poll |
| `SQS_MAX_ATTEMPTS` | `5` | Entregas antes de uma falha transitória ir para a DLQ |
| `WORKERS` | todos | `consumer,outbox,references,sampler` ou `none` |
| `LOG_LEVEL` | `info` | `debug` · `info` · `warn` · `error` |
| `SWAGGER_ENABLED` | `true` | Swagger UI em `/docs` e OpenAPI em `/docs-json` |

## Estrutura

```
src/
├── domain/            Money, Wallet, WalletLedgerEntry, WagerTransaction, WagerProcessor, eventos, inbox/outbox
├── application/       use cases (SubmitWagerTransaction, OpenWallet, PublishOutbox, ReprocessPendingReferences,
│                      WalletQueries) e portas
├── infrastructure/    MikroORM (records, mappers, repositórios, migrations), SQS, logs, métricas, health
├── interfaces/        HTTP (NestJS), consumidor SQS, workers
├── composition-root.ts
└── main.ts
test/unit/             domínio e utilitários
test/integration/      schema, use cases, HTTP, mensageria, observabilidade, 3 processos reais
scripts/               migrate, send-wager-message, load-test
infra/localstack/      criação das filas
```

## Autenticação

Não implementada, por decisão documentada em `ARCHITECTURE.md` §15; o ponto de extensão está em
`src/interfaces/http/auth.ts` (`ProviderIdentityPort` + `ProviderAuthGuard`).
