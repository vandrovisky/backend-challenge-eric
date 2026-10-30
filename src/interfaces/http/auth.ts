import { type CanActivate, type ExecutionContext, ForbiddenException, Inject, Injectable } from "@nestjs/common";
import type { Request } from "express";
import { PROVIDER_IDENTITY } from "./tokens";

/**
 * Authentication extension point (README section 2). Authentication is intentionally NOT implemented:
 * see ARCHITECTURE.md for the intended design (OIDC client-credentials via an external IdP such as
 * Keycloak; the token's `provider_id` claim becomes `ProviderIdentity.providerId`).
 */
export interface ProviderIdentity {
  /** Provider the caller is authenticated as; undefined when no authentication is configured. */
  providerId?: string;
  subject: string;
}

export interface ProviderIdentityPort {
  /** Returns the caller's identity, or null to reject the request with 401. */
  authenticate(request: Request): Promise<ProviderIdentity | null>;
}

/** No-op adapter: every caller is accepted as anonymous. Replace with an OIDC/JWT adapter. */
export class AnonymousProviderIdentity implements ProviderIdentityPort {
  async authenticate(): Promise<ProviderIdentity> {
    return { subject: "anonymous" };
  }
}

export type AuthenticatedRequest = Request & { identity?: ProviderIdentity };

@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(@Inject(PROVIDER_IDENTITY) private readonly identity: ProviderIdentityPort) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const identity = await this.identity.authenticate(req);
    if (!identity) return false; // Nest answers 403; a real adapter would throw UnauthorizedException
    req.identity = identity;
    return true;
  }
}

/** Domain check that stays in force even with auth enabled: a provider can only act as itself. */
export function assertActsAsSelf(req: AuthenticatedRequest, providerId: unknown): void {
  const authenticated = req.identity?.providerId;
  if (authenticated && authenticated !== providerId) {
    throw new ForbiddenException({ code: "PROVIDER_MISMATCH", message: "providerId does not match the caller" });
  }
}
