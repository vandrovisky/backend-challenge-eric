import { Migrator } from "@mikro-orm/migrations";
import { defineConfig } from "@mikro-orm/postgresql";
import { Migration20261028000001_initial_schema } from "./migrations/Migration20261028000001_initial_schema";
import { ALL_SCHEMAS } from "./records";

export const DEFAULT_DATABASE_URL = "postgres://wagering:wagering@localhost:5432/wagering";

export function buildOrmConfig(databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL) {
  return defineConfig({
    clientUrl: databaseUrl,
    entities: ALL_SCHEMAS,
    extensions: [Migrator],
    // Explicit list: no filesystem glob discovery, works the same under Bun, tests and Docker.
    migrations: {
      tableName: "mikro_orm_migrations",
      transactional: true,
      allOrNothing: true,
      migrationsList: [
        { name: "Migration20261028000001_initial_schema", class: Migration20261028000001_initial_schema },
      ],
    },
    pool: { min: 1, max: Number(process.env.DB_POOL_MAX ?? 10) },
    // Every write path runs in an explicit em.transactional(); the global context is never used.
    allowGlobalContext: false,
    debug: process.env.ORM_DEBUG === "true",
  });
}
