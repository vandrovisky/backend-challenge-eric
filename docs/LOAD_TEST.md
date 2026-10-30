# Resultados do teste de carga

Gerado por `bun run test:load` em 2026-10-30T00:26:44.070Z. Rodar de novo sobrescreve este arquivo.

## Ambiente

| | |
|---|---|
| CPU | Intel(R) Core(TM) 5 210H × 12 núcleos lógicos |
| Memória | 7.6 GiB |
| SO | linux 6.6.87.2-microsoft-standard-WSL2 |
| Runtime | Bun 1.4.4 |
| PostgreSQL | 17.11 (Docker, configuração padrão) |
| SQS | LocalStack 4.0 (Docker) |
| Topologia | 3 processos do serviço (HTTP + consumidor + relay da outbox + worker de referências em cada), pool de 10 conexões cada; gerador de carga na mesma máquina |

Tudo roda em UMA máquina (WSL2 + Docker Desktop): gerador, as 3 instâncias, Postgres e LocalStack disputam a mesma
CPU. Os números absolutos são um piso, não uma estimativa de capacidade.

## Metodologia

- **Fase 1 — HTTP**: 64 clientes em loop fechado (cada um espera a resposta antes de enviar a próxima) por 30s,
  em round-robin nas 3 instâncias. 200 wallets; 20% das operações vão para UMA wallet quente
  (pior caso para o lock por wallet); 10% das requisições são reenvios idênticos (replays idempotentes).
  Mistura: 60% BET / 25% WIN / 15% LOSS, valores de 1.00 a 5.99.
- **Fase 2 — SQS**: 2000 mensagens em 50 wallets publicadas na fila FIFO de entrada (agrupadas por wallet);
  mede-se o tempo até todas estarem commitadas (inbox) e a fila vazia.
- Latência = medida no cliente, do início da requisição até o corpo completo da resposta.

## Resultados — HTTP

| Métrica | Valor |
|---|---|
| Requisições | 8600 (898 replays intencionais) |
| Throughput | **282.7 req/s** |
| Latência p50 / p95 / p99 | **138.7 / 793.1 / 1071.3 ms** |
| Latência máxima | 1878.8 ms |
| Status HTTP | 200: 898, 201: 7702 |
| Taxa de erro (5xx + transporte) | 0.00% (0 5xx, 0 de transporte) |
| Replays idempotentes servidos | 898 |
| Conflitos de concorrência (lock timeout, corridas de versão/chave duplicada) | 0 |
| Espera média pelo lock da wallet | 65.58 ms em 9727 aquisições |
| Outbox lag durante a carga (p50 / p95 / máx) | 858 / 1424 / 1522 ms |
| Tempo para zerar a outbox após a carga | 0.20 s |

Respostas 422 seriam rejeições de negócio (só esperadas se uma wallet ficasse sem saldo), não erros.

### Latência por tipo de requisição (ms)

| Tipo | Requisições | p50 | p95 | p99 |
|---|---|---|---|---|
| Wallet quente (operação nova) | 1540 | 586.5 | 1093.1 | 1446.5 |
| Wallets frias (operação nova) | 6162 | 123.6 | 434.4 | 557.7 |
| Replay (duplicata) | 898 | 49.0 | 254.5 | 520.3 |

## Resultados — SQS

| Métrica | Valor |
|---|---|
| Mensagens | 2000 (publicadas em 12.7 s) |
| Tempo até processar todas | 26.9 s |
| Throughput | **74.4 msg/s** (3 consumidores) |
| DLQ | 0 |

## Correção após a carga

| Verificação | Resultado |
|---|---|
| Wallets com saldo ≠ replay do ledger | **0** de 200 |

## Análise

- **Wallet quente × wallets frias**: p99 1446.5 ms × 557.7 ms. As operações da wallet quente são serializadas pelo lock da linha (por desenho: é o que garante o saldo correto), então fazem fila e dominam a cauda.
- **Replays**: p50 49.0 ms × 156.5 ms das operações novas. Replays usam o caminho rápido sem lock (uma busca indexada pela idempotency key) e são mais baratos.
- **Conflitos de concorrência = 0**: o lock pessimista faz os escritores esperarem em vez de falharem, então nenhuma requisição precisou de retry; a disputa aparece como espera pelo lock (média 65.6 ms), não como erro.
- **Outbox lag** ficou em torno de 858 ms (o relay consulta a cada 500 ms quando ocioso e drena continuamente sob carga); zerou 0.20 s depois do fim da carga.
- **SQS (74.4 msg/s) é mais lento que HTTP**: cada mensagem custa idas e voltas extras ao broker (receive + delete) no LocalStack, e a FIFO só entrega as próximas mensagens de um grupo (wallet) depois que as anteriores em voo são resolvidas.
- **Limites do experimento**: uma única máquina para tudo (gerador de carga, 3 instâncias, Postgres, LocalStack) sob WSL2; Postgres sem tuning; LocalStack é um emulador com desempenho diferente do SQS real. Os números são um piso, úteis para comparação relativa, não para planejamento de capacidade.
