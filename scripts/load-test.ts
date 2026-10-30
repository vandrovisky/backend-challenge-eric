/**
 * Load test: 3 real service processes, real Postgres, real LocalStack SQS.
 *
 *   bun run test:load                      # defaults below
 *   DURATION_S=60 CONCURRENCY=128 bun run test:load
 *
 * Phase 1 (HTTP): CONCURRENCY closed-loop clients for DURATION_S seconds, round-robin over 3 instances.
 *   Mix: 60% BET / 25% WIN / 15% LOSS, DUP_SHARE of requests are exact resends (idempotent replays),
 *   HOT_SHARE of operations target ONE hot wallet (worst case for the per-wallet lock).
 * Phase 2 (SQS): QUEUE_MESSAGES messages published up front, time until the 3 consumers drain them.
 * Then: outbox drain time and a full reconciliation of every wallet touched.
 *
 * Writes the report to docs/LOAD_TEST.md.
 */
import { cpus, totalmem, platform, release } from "node:os";
import { join } from "node:path";
import { MikroORM } from "@mikro-orm/postgresql";
import { newId } from "../src/domain/shared/id";
import { buildOrmConfig } from "../src/infrastructure/persistence/mikro-orm.config";
import { connect } from "../test/integration/support/database";
import { approximateCount, createTestQueues, envelope, send, testSqsClient } from "../test/integration/support/queues";
import { scrapeCounter, startInstances, type ServiceInstance } from "../test/support/instances";

const DURATION_S = Number(process.env.DURATION_S ?? 30);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 64);
const WALLETS = Number(process.env.WALLETS ?? 200);
const HOT_SHARE = Number(process.env.HOT_SHARE ?? 0.2);
const DUP_SHARE = Number(process.env.DUP_SHARE ?? 0.1);
const QUEUE_MESSAGES = Number(process.env.QUEUE_MESSAGES ?? 2000);
const BASE_PORT = Number(process.env.BASE_PORT ?? 3200);

const pct = (sorted: number[], p: number) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]! : 0;
const fmt = (n: number, d = 1) => n.toFixed(d);

// ---------------------------------------------------------------- setup
{
  const orm = await MikroORM.init(buildOrmConfig());
  await orm.migrator.up();
  await orm.close();
}
const sql = connect();
const sqs = testSqsClient();
const queues = await createTestQueues(sqs);

console.log(`starting 3 instances on :${BASE_PORT}-${BASE_PORT + 2} …`);
const instances: ServiceInstance[] = await startInstances(3, BASE_PORT, {
  SQS_INPUT_QUEUE: queues.inputQueueName,
  SQS_DLQ: queues.dlqName,
  SQS_EVENTS_QUEUE: queues.eventsQueueName,
  SQS_WAIT_TIME_SECONDS: "1",
  DB_POOL_MAX: "10",
  LOG_LEVEL: "error",
});


let rr = 0;
const pick = () => instances[rr++ % instances.length]!;

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${pick().url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, any>;
  return { status: res.status, body: json };
}

console.log(`creating ${WALLETS} wallets …`);
const wallets: Array<{ walletId: string; playerId: string }> = [];
for (let i = 0; i < WALLETS; i += 20) {
  const batch = await Promise.all(
    Array.from({ length: Math.min(20, WALLETS - i) }, async () => {
      const playerId = newId();
      const r = await post("/wallets", { playerId, initialBalance: { amount: "100000.00", currency: "BRL" } });
      return { walletId: r.body.id as string, playerId };
    }),
  );
  wallets.push(...batch);
}
const hot = wallets[0]!;

function newOperation() {
  const w = Math.random() < HOT_SHARE ? hot : wallets[1 + Math.floor(Math.random() * (wallets.length - 1))]!;
  const r = Math.random();
  const kind = r < 0.6 ? "BET" : r < 0.85 ? "WIN" : "LOSS";
  const amount = `${1 + Math.floor(Math.random() * 5)}.${String(Math.floor(Math.random() * 100)).padStart(2, "0")}`;
  const externalTransactionId = `load-${newId()}`;
  return {
    body: {
      providerId: "provider-load",
      externalTransactionId,
      playerId: w.playerId,
      walletId: w.walletId,
      roundId: `round-${Math.floor(Math.random() * 1000)}`,
      gameId: "fortune-chimp",
      kind,
      money: { amount, currency: "BRL" },
    },
    headers: { "Idempotency-Key": `provider-load:${externalTransactionId}` },
  };
}

// ---------------------------------------------------------------- phase 1: HTTP
console.log(`phase 1: HTTP, ${CONCURRENCY} clients × ${DURATION_S}s …`);
const latencies: number[] = [];
const byCategory: Record<"hot" | "cold" | "replay", number[]> = { hot: [], cold: [], replay: [] };
const statuses = new Map<number, number>();
let transportErrors = 0;
let replaysSent = 0;
const sent: ReturnType<typeof newOperation>[] = [];
const lagSamples: number[] = [];
const end = Date.now() + DURATION_S * 1000;

const sampler = (async () => {
  while (Date.now() < end) {
    const [row] = await sql`SELECT COALESCE(EXTRACT(EPOCH FROM (now() - MIN(occurred_at))) * 1000, 0)::float8 AS lag
                              FROM outbox_messages WHERE published_at IS NULL`;
    lagSamples.push(Number(row.lag));
    await Bun.sleep(1000);
  }
})();

const httpStarted = performance.now();
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (Date.now() < end) {
      let op: ReturnType<typeof newOperation>;
      let category: "hot" | "cold" | "replay";
      if (sent.length > 0 && Math.random() < DUP_SHARE) {
        op = sent[Math.floor(Math.random() * sent.length)]!;
        replaysSent += 1;
        category = "replay";
      } else {
        op = newOperation();
        sent.push(op);
        category = op.body.walletId === hot.walletId ? "hot" : "cold";
      }
      const t0 = performance.now();
      try {
        const r = await post("/wagering/transactions", op.body, op.headers);
        const ms = performance.now() - t0;
        latencies.push(ms);
        byCategory[category].push(ms);
        statuses.set(r.status, (statuses.get(r.status) ?? 0) + 1);
      } catch {
        transportErrors += 1;
      }
    }
  }),
);
const httpSeconds = (performance.now() - httpStarted) / 1000;
await sampler;

const outboxDrainStart = performance.now();
for (;;) {
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM outbox_messages WHERE published_at IS NULL`;
  if (n === 0) break;
  await Bun.sleep(200);
}
const outboxDrainSeconds = (performance.now() - outboxDrainStart) / 1000;

// ---------------------------------------------------------------- phase 2: SQS
console.log(`phase 2: SQS, ${QUEUE_MESSAGES} messages …`);
const queueWallets = wallets.slice(1, 51);
const msgs = Array.from({ length: QUEUE_MESSAGES }, (_, i) => {
  const w = queueWallets[i % queueWallets.length]!;
  const ext = `q-${newId()}`;
  return envelope({
    providerId: "provider-load",
    externalTransactionId: ext,
    idempotencyKey: `provider-load:${ext}`,
    playerId: w.playerId,
    walletId: w.walletId,
    roundId: "q",
    gameId: "fortune-chimp",
    kind: i % 2 ? "BET" : "WIN",
    money: { amount: "1.00", currency: "BRL" },
  });
});
// Publish first (consumers are already running and start draining immediately), then time the drain.
const queueStarted = performance.now();
for (let i = 0; i < msgs.length; i += 50) {
  await Promise.all(msgs.slice(i, i + 50).map((m) => send(sqs, queues.inputQueueName, m)));
}
const publishSeconds = (performance.now() - queueStarted) / 1000;
for (;;) {
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM inbox_messages WHERE message_id IN ${sql(msgs.map((m) => m.messageId))}`;
  if (n === msgs.length && (await approximateCount(sqs, queues.inputQueueName)) === 0) break;
  await Bun.sleep(250);
}
const queueSeconds = (performance.now() - queueStarted) / 1000;

// ---------------------------------------------------------------- results
const lockConflicts = await scrapeCounter(instances, "wager_lock_conflicts_total");
const duplicates = await scrapeCounter(instances, "wager_duplicates_total");
const lockWaitSum = await scrapeCounter(instances, "wallet_lock_wait_ms_sum");
const lockWaitCount = await scrapeCounter(instances, "wallet_lock_wait_ms_count");
const dlq = await approximateCount(sqs, queues.dlqName);

const [{ inconsistent }] = await sql`
  SELECT count(*)::int AS inconsistent FROM (
    SELECT w.id FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
     WHERE w.id IN ${sql(wallets.map((w) => w.walletId))}
     GROUP BY w.id, w.balance
    HAVING w.balance <> COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0)) x`;
const [{ pgVersion }] = await sql`SELECT current_setting('server_version') AS "pgVersion"`;

await Promise.all(instances.map((i) => i.stop()));
await sql.close();
sqs.destroy();

const sorted = [...latencies].sort((a, b) => a - b);
const total = latencies.length + transportErrors;
const s5xx = [...statuses].filter(([s]) => s >= 500).reduce((a, [, n]) => a + n, 0);
const lagSorted = [...lagSamples].sort((a, b) => a - b);
const catRow = (name: string, xs: number[]) => {
  const c = [...xs].sort((a, b) => a - b);
  return `| ${name} | ${c.length} | ${fmt(pct(c, 50))} | ${fmt(pct(c, 95))} | ${fmt(pct(c, 99))} |`;
};
function analysis(): string {
  const p = (xs: number[], q: number) => pct([...xs].sort((a, b) => a - b), q);
  const hot99 = p(byCategory.hot, 99);
  const cold99 = p(byCategory.cold, 99);
  const rep50 = p(byCategory.replay, 50);
  const new50 = p([...byCategory.hot, ...byCategory.cold], 50);
  const lines = [
    `- **Wallet quente × wallets frias**: p99 ${fmt(hot99)} ms × ${fmt(cold99)} ms. ` +
      (hot99 > cold99 * 1.2
        ? "As operações da wallet quente são serializadas pelo lock da linha (por desenho: é o que garante o saldo correto), então fazem fila e dominam a cauda."
        : "A wallet quente NÃO ficou claramente mais lenta: nesta carga o gargalo é compartilhado (CPU / pool de conexões), não o lock por wallet."),
    `- **Replays**: p50 ${fmt(rep50)} ms × ${fmt(new50)} ms das operações novas. ` +
      (rep50 < new50
        ? "Replays usam o caminho rápido sem lock (uma busca indexada pela idempotency key) e são mais baratos."
        : "Replays não ficaram mais baratos, então o caminho rápido não é o que domina a latência; a fila nos recursos compartilhados é."),
    `- **Conflitos de concorrência = ${lockConflicts}**: o lock pessimista faz os escritores esperarem em vez de falharem, então nenhuma requisição precisou de retry; a disputa aparece como espera pelo lock (média ${fmt(lockWaitCount ? lockWaitSum / lockWaitCount : 0, 1)} ms), não como erro.`,
    `- **Outbox lag** ficou em torno de ${fmt(pct(lagSorted, 50), 0)} ms (o relay consulta a cada 500 ms quando ocioso e drena continuamente sob carga); zerou ${fmt(outboxDrainSeconds, 2)} s depois do fim da carga.`,
    `- **SQS (${fmt(QUEUE_MESSAGES / queueSeconds)} msg/s) é mais lento que HTTP**: cada mensagem custa idas e voltas extras ao broker (receive + delete) no LocalStack, e a FIFO só entrega as próximas mensagens de um grupo (wallet) depois que as anteriores em voo são resolvidas.`,
    "- **Limites do experimento**: uma única máquina para tudo (gerador de carga, 3 instâncias, Postgres, LocalStack) sob WSL2; Postgres sem tuning; LocalStack é um emulador com desempenho diferente do SQS real. Os números são um piso, úteis para comparação relativa, não para planejamento de capacidade.",
  ];
  return lines.join("\n");
}

const statusLine = [...statuses].sort(([a], [b]) => a - b).map(([s, n]) => `${s}: ${n}`).join(", ");

const report = `# Resultados do teste de carga

Gerado por \`bun run test:load\` em ${new Date().toISOString()}. Rodar de novo sobrescreve este arquivo.

## Ambiente

| | |
|---|---|
| CPU | ${cpus()[0]?.model ?? "?"} × ${cpus().length} núcleos lógicos |
| Memória | ${fmt(totalmem() / 1024 ** 3)} GiB |
| SO | ${platform()} ${release()} |
| Runtime | Bun ${Bun.version} |
| PostgreSQL | ${pgVersion} (Docker, configuração padrão) |
| SQS | LocalStack 4.0 (Docker) |
| Topologia | 3 processos do serviço (HTTP + consumidor + relay da outbox + worker de referências em cada), pool de 10 conexões cada; gerador de carga na mesma máquina |

Tudo roda em UMA máquina (WSL2 + Docker Desktop): gerador, as 3 instâncias, Postgres e LocalStack disputam a mesma
CPU. Os números absolutos são um piso, não uma estimativa de capacidade.

## Metodologia

- **Fase 1 — HTTP**: ${CONCURRENCY} clientes em loop fechado (cada um espera a resposta antes de enviar a próxima) por ${DURATION_S}s,
  em round-robin nas 3 instâncias. ${WALLETS} wallets; ${fmt(HOT_SHARE * 100, 0)}% das operações vão para UMA wallet quente
  (pior caso para o lock por wallet); ${fmt(DUP_SHARE * 100, 0)}% das requisições são reenvios idênticos (replays idempotentes).
  Mistura: 60% BET / 25% WIN / 15% LOSS, valores de 1.00 a 5.99.
- **Fase 2 — SQS**: ${QUEUE_MESSAGES} mensagens em 50 wallets publicadas na fila FIFO de entrada (agrupadas por wallet);
  mede-se o tempo até todas estarem commitadas (inbox) e a fila vazia.
- Latência = medida no cliente, do início da requisição até o corpo completo da resposta.

## Resultados — HTTP

| Métrica | Valor |
|---|---|
| Requisições | ${total} (${replaysSent} replays intencionais) |
| Throughput | **${fmt(latencies.length / httpSeconds)} req/s** |
| Latência p50 / p95 / p99 | **${fmt(pct(sorted, 50))} / ${fmt(pct(sorted, 95))} / ${fmt(pct(sorted, 99))} ms** |
| Latência máxima | ${fmt(sorted[sorted.length - 1] ?? 0)} ms |
| Status HTTP | ${statusLine} |
| Taxa de erro (5xx + transporte) | ${fmt(((s5xx + transportErrors) / Math.max(1, total)) * 100, 2)}% (${s5xx} 5xx, ${transportErrors} de transporte) |
| Replays idempotentes servidos | ${duplicates} |
| Conflitos de concorrência (lock timeout, corridas de versão/chave duplicada) | ${lockConflicts} |
| Espera média pelo lock da wallet | ${fmt(lockWaitCount ? lockWaitSum / lockWaitCount : 0, 2)} ms em ${lockWaitCount} aquisições |
| Outbox lag durante a carga (p50 / p95 / máx) | ${fmt(pct(lagSorted, 50), 0)} / ${fmt(pct(lagSorted, 95), 0)} / ${fmt(lagSorted[lagSorted.length - 1] ?? 0, 0)} ms |
| Tempo para zerar a outbox após a carga | ${fmt(outboxDrainSeconds, 2)} s |

Respostas 422 seriam rejeições de negócio (só esperadas se uma wallet ficasse sem saldo), não erros.

### Latência por tipo de requisição (ms)

| Tipo | Requisições | p50 | p95 | p99 |
|---|---|---|---|---|
${catRow("Wallet quente (operação nova)", byCategory.hot)}
${catRow("Wallets frias (operação nova)", byCategory.cold)}
${catRow("Replay (duplicata)", byCategory.replay)}

## Resultados — SQS

| Métrica | Valor |
|---|---|
| Mensagens | ${QUEUE_MESSAGES} (publicadas em ${fmt(publishSeconds, 1)} s) |
| Tempo até processar todas | ${fmt(queueSeconds, 1)} s |
| Throughput | **${fmt(QUEUE_MESSAGES / queueSeconds)} msg/s** (3 consumidores) |
| DLQ | ${dlq} |

## Correção após a carga

| Verificação | Resultado |
|---|---|
| Wallets com saldo ≠ replay do ledger | **${inconsistent}** de ${wallets.length} |

## Análise

${analysis()}
`;

await Bun.write(join(import.meta.dir, "..", "docs", "LOAD_TEST.md"), report);
console.log(report);
