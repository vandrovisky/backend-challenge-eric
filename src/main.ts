import "reflect-metadata";
import { createCore } from "./composition-root";
import { createHttpApp } from "./interfaces/http/http-app";
import { WorkerHost, workersFromEnv } from "./interfaces/workers/worker-host";

const core = await createCore();
const app = await createHttpApp(core);
const workers = new WorkerHost(core, workersFromEnv());

await app.listen(core.config.port, "0.0.0.0");
workers.start();
core.logger.info("instance ready", { port: core.config.port, workers: workersFromEnv().join(",") });

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  core.logger.info("shutting down", { signal });
  // 1. stop taking queue messages; finish (and ack) the ones in flight, release the rest
  await workers.stop();
  // 2. stop HTTP: refuse new connections, wait for in-flight requests
  await app.close();
  // 3. release DB pool and SQS client
  await core.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
