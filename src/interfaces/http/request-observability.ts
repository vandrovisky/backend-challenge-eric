import type { NextFunction, Request, Response } from "express";
import type { AppLogger, Metrics } from "../../application/ports/observability";
import { correlationIdOf } from "./correlation";

const QUIET = /^\/(health|metrics|docs)/;

/**
 * One structured log line + latency/count metrics per HTTP request. Uses the route TEMPLATE
 * (`/wallets/:walletId`) as label, never the concrete path, so ids don't explode metric cardinality.
 * Bodies, headers and query strings are never logged.
 */
export function requestObservability(logger: AppLogger, metrics: Metrics) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const started = performance.now();
    res.on("finish", () => {
      const durationMs = Math.round((performance.now() - started) * 10) / 10;
      const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : "unmatched";
      const labels = { method: req.method, route, status: String(res.statusCode) };
      metrics.increment("http_requests_total", labels);
      metrics.observe("http_request_duration_ms", durationMs, { method: req.method, route });
      const fields = {
        correlationId: correlationIdOf(req),
        method: req.method,
        route,
        status: res.statusCode,
        durationMs,
      };
      if (QUIET.test(req.path)) logger.debug("http request", fields);
      else if (res.statusCode >= 500) logger.error("http request", fields);
      else logger.info("http request", fields);
    });
    next();
  };
}
