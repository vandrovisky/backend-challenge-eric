import "reflect-metadata";
import { type DynamicModule, type INestApplication, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import type { Core } from "../../composition-root";
import { AnonymousProviderIdentity, ProviderAuthGuard, type ProviderIdentityPort } from "./auth";
import { correlationMiddleware } from "./correlation";
import { ErrorFilter } from "./error.filter";
import { HealthController } from "./health.controller";
import { EXTRA_MODELS } from "./openapi/schemas";
import { requestObservability } from "./request-observability";
import { CORE, PROVIDER_IDENTITY } from "./tokens";
import { WageringController } from "./wagering.controller";
import { WalletsController } from "./wallets.controller";

@Module({})
export class HttpModule {
  static register(core: Core, identity: ProviderIdentityPort): DynamicModule {
    return {
      module: HttpModule,
      controllers: [WalletsController, WageringController, HealthController],
      providers: [
        { provide: CORE, useValue: core },
        { provide: PROVIDER_IDENTITY, useValue: identity },
        ProviderAuthGuard,
      ],
    };
  }
}

/** Builds the Nest HTTP application on top of an already-wired core. */
export async function createHttpApp(
  core: Core,
  identity: ProviderIdentityPort = new AnonymousProviderIdentity(),
): Promise<INestApplication> {
  const app = await NestFactory.create(HttpModule.register(core, identity), {
    logger: ["error", "warn"],
    bodyParser: true,
  });
  app.use(correlationMiddleware);
  app.use(requestObservability(core.logger, core.metrics));
  app.useGlobalFilters(new ErrorFilter(core.logger));
  app.enableShutdownHooks();
  if (core.config.swaggerEnabled) setupSwagger(app);
  return app;
}

/** Swagger UI at /docs, OpenAPI JSON at /docs-json (importable in Postman/Insomnia). */
export function setupSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle("Distributed Wagering Processor")
    .setDescription(
      [
        "Wallets and wagering transactions (BET, WIN, LOSS, REFUND, ROLLBACK).",
        "",
        "Quick test: 1) POST /wallets (copy `id` and `playerId`) → 2) POST /wagering/transactions with a new",
        "Idempotency-Key, replacing <walletId>/<playerId> in the example → 3) send it again: 200 replay → 4) GET the",
        "ledger and run the reconciliation.",
        "",
        "Money is always a decimal string with at most 2 places (\"25.00\"), never a JSON number.",
        "Authentication is not implemented (see ARCHITECTURE.md §15).",
      ].join("\n"),
    )
    .setVersion("1.0")
    .addTag("wallets")
    .addTag("wagering")
    .addTag("operations", "Health checks and metrics (unauthenticated)")
    .build();
  const document = SwaggerModule.createDocument(app, config, { extraModels: EXTRA_MODELS });
  SwaggerModule.setup("docs", app, document, {
    jsonDocumentUrl: "docs-json",
    swaggerOptions: { persistAuthorization: true, displayRequestDuration: true, tryItOutEnabled: true },
  });
}
