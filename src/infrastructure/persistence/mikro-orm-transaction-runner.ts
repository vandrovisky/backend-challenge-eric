import type { MikroORM } from "@mikro-orm/postgresql";
import type { TransactionalRepositories, TransactionRunner } from "../../application/ports/persistence";
import { translateDatabaseError } from "./database-errors";
import { createRepositories } from "./mikro-orm-repositories";

/**
 * One SQL transaction per `run` call, on a fresh forked EntityManager (its own Unit of Work and
 * Identity Map — nothing leaks between requests). READ COMMITTED is enough because every writer first
 * takes the wallet row lock; each later statement then sees everything committed before the lock.
 *
 * `lock_timeout` bounds how long a hot wallet can make a request wait: past it Postgres raises
 * 55P03, which surfaces as a transient (retryable) error instead of an unbounded hang.
 */
export class MikroOrmTransactionRunner implements TransactionRunner {
  constructor(
    private readonly orm: MikroORM,
    private readonly opts: { lockTimeoutMs: number; statementTimeoutMs: number } = {
      lockTimeoutMs: 5_000,
      statementTimeoutMs: 15_000,
    },
  ) {}

  async run<T>(work: (repos: TransactionalRepositories) => Promise<T>): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(async (em) => {
        await em.execute(
          `SET LOCAL lock_timeout = '${Math.trunc(this.opts.lockTimeoutMs)}ms';
           SET LOCAL statement_timeout = '${Math.trunc(this.opts.statementTimeoutMs)}ms'`,
        );
        return work(createRepositories(em));
      });
    } catch (error) {
      throw translateDatabaseError(error);
    }
  }

  async read<T>(work: (repos: TransactionalRepositories) => Promise<T>): Promise<T> {
    try {
      return await work(createRepositories(this.orm.em.fork()));
    } catch (error) {
      throw translateDatabaseError(error);
    }
  }
}
