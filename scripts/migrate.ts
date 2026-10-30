import { MikroORM } from "@mikro-orm/postgresql";
import { buildOrmConfig } from "../src/infrastructure/persistence/mikro-orm.config";

/** Usage: bun run scripts/migrate.ts up | down [--to <name>|--all] | status */
const [command = "up", ...rest] = process.argv.slice(2);

const orm = await MikroORM.init(buildOrmConfig());
try {
  const migrator = orm.migrator;
  if (command === "up") {
    const done = await migrator.up();
    console.log(done.length ? `applied: ${done.map((m) => m.name).join(", ")}` : "already up to date");
  } else if (command === "down") {
    const to = rest.includes("--all") ? 0 : rest[rest.indexOf("--to") + 1];
    const done = await migrator.down(rest.includes("--all") ? { to: 0 } : to && rest.includes("--to") ? { to } : undefined);
    console.log(done.length ? `reverted: ${done.map((m) => m.name).join(", ")}` : "nothing to revert");
  } else if (command === "status") {
    const executed = await migrator.getExecuted();
    const pending = await migrator.getPending();
    console.log({ executed: executed.map((m) => m.name), pending: pending.map((m) => m.name) });
  } else {
    throw new Error(`unknown command ${command}`);
  }
} finally {
  await orm.close();
}
