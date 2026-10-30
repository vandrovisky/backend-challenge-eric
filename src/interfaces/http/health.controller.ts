import { Controller, Get, Header, Inject, Res } from "@nestjs/common";
import { ApiOperation, ApiProduces, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import type { Core } from "../../composition-root";
import { ReadinessResponse } from "./openapi/schemas";
import { CORE } from "./tokens";

/** Unauthenticated by design (README section 2): no guard on this controller. */
@ApiTags("operations")
@Controller()
export class HealthController {
  constructor(@Inject(CORE) private readonly core: Core) {}

  /** Process is up and the event loop answers. Never checks dependencies (a DB outage must not restart pods). */
  @Get("health/live")
  @ApiOperation({ summary: "Liveness: the process answers (never checks dependencies)" })
  live() {
    return { status: "ok", uptimeSeconds: Math.round(process.uptime()) };
  }

  /** PostgreSQL and SQS reachable → 200, otherwise 503 with per-dependency detail. */
  @Get("health/ready")
  @ApiOperation({ summary: "Readiness: PostgreSQL and SQS reachable" })
  @ApiResponse({ status: 200, type: ReadinessResponse })
  @ApiResponse({ status: 503, type: ReadinessResponse })
  async ready(@Res({ passthrough: true }) res: Response) {
    const report = await this.core.health.readiness();
    res.status(report.status === "ready" ? 200 : 503);
    return report;
  }

  @Get("metrics")
  @ApiOperation({ summary: "Prometheus metrics (text exposition format)" })
  @ApiProduces("text/plain")
  @Header("Content-Type", "text/plain; version=0.0.4")
  metrics() {
    return this.core.metrics.render();
  }
}
