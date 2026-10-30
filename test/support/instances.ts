import type { Subprocess } from "bun";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

export interface InstanceOptions {
  port: number;
  env?: Record<string, string>;
  /** Write the instance's stdout/stderr here (default: discarded). */
  logFile?: string;
}

/** A real, separate OS process running the full service (HTTP + workers), exactly like production. */
export class ServiceInstance {
  private proc?: Subprocess;

  constructor(readonly opts: InstanceOptions) {}

  get url(): string {
    return `http://127.0.0.1:${this.opts.port}`;
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  async start(timeoutMs = 30_000): Promise<void> {
    const out = this.opts.logFile ? Bun.file(this.opts.logFile) : "ignore";
    this.proc = Bun.spawn(["bun", "run", "src/main.ts"], {
      cwd: ROOT,
      env: { ...process.env, LOG_LEVEL: "warn", ...this.opts.env, PORT: String(this.opts.port) },
      stdout: out,
      stderr: out,
    });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.proc.exitCode !== null) throw new Error(`instance :${this.opts.port} exited with ${this.proc.exitCode}`);
      try {
        const r = await fetch(`${this.url}/health/ready`);
        if (r.status === 200) return;
      } catch {
        // not listening yet
      }
      await Bun.sleep(200);
    }
    throw new Error(`instance :${this.opts.port} not ready after ${timeoutMs}ms`);
  }

  /** Graceful stop (SIGTERM): waits for in-flight work, like an orchestrator rolling restart. */
  async stop(): Promise<number | null> {
    if (!this.proc || this.proc.exitCode !== null) return this.proc?.exitCode ?? null;
    this.proc.kill("SIGTERM");
    return this.proc.exited;
  }

  /** Crash (SIGKILL): no cleanup at all, like an OOM kill or a node failure. */
  async kill(): Promise<void> {
    if (!this.proc || this.proc.exitCode !== null) return;
    this.proc.kill("SIGKILL");
    await this.proc.exited;
  }
}

export async function startInstances(
  count: number,
  basePort: number,
  env: Record<string, string>,
  logDir?: string,
): Promise<ServiceInstance[]> {
  const instances = Array.from(
    { length: count },
    (_, i) =>
      new ServiceInstance({
        port: basePort + i,
        env: { ...env, HOSTNAME: `instance-${i + 1}` },
        ...(logDir ? { logFile: join(logDir, `instance-${i + 1}.log`) } : {}),
      }),
  );
  await Promise.all(instances.map((i) => i.start()));
  return instances;
}

/** Sums one counter (all label sets) across every instance's /metrics. */
export async function scrapeCounter(instances: ServiceInstance[], name: string, labelFilter?: string): Promise<number> {
  let total = 0;
  for (const inst of instances) {
    let text = "";
    try {
      text = await (await fetch(`${inst.url}/metrics`)).text();
    } catch {
      continue; // a killed instance has no metrics to scrape
    }
    for (const line of text.split("\n")) {
      if (line.startsWith("#") || !line.startsWith(name)) continue;
      const rest = line.slice(name.length);
      if (!(rest.startsWith("{") || rest.startsWith(" "))) continue;
      if (labelFilter && !line.includes(labelFilter)) continue;
      total += Number(line.split(" ").pop());
    }
  }
  return total;
}
