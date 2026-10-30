import { MikroORM } from "@mikro-orm/postgresql";
import { SQL } from "bun";
import { buildOrmConfig, DEFAULT_DATABASE_URL } from "../../../src/infrastructure/persistence/mikro-orm.config";

export const DATABASE_URL = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;

/** Drops and recreates the schema through the real migrations (also proves they are reversible). */
export async function resetDatabase(): Promise<void> {
  const orm = await MikroORM.init({ ...buildOrmConfig(DATABASE_URL), debug: false });
  try {
    await orm.migrator.down({ to: 0 });
    await orm.migrator.up();
  } finally {
    await orm.close();
  }
}

export function connect(): SQL {
  return new SQL(DATABASE_URL, { max: 20 });
}
