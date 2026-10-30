import type { NextFunction, Request, Response } from "express";
import { newId } from "../../domain/shared/id";

export const CORRELATION_HEADER = "x-correlation-id";
const SAFE = /^[A-Za-z0-9._:-]{1,128}$/;

/** Accepts the caller's X-Correlation-Id (if well-formed) or generates one; echoes it on the response. */
export function correlationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header(CORRELATION_HEADER);
  const correlationId = incoming && SAFE.test(incoming) ? incoming : newId();
  (req as Request & { correlationId: string }).correlationId = correlationId;
  res.setHeader("X-Correlation-Id", correlationId);
  next();
}

export function correlationIdOf(req: Request): string {
  return (req as Request & { correlationId?: string }).correlationId ?? newId();
}
