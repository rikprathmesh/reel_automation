import { Injectable, type OnModuleDestroy, type OnModuleInit, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.ts";
import type { AppEnv } from "../config/env.ts";

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger("Prisma");

  constructor(config: ConfigService<AppEnv, true>) {
    super({ adapter: new PrismaPg({ connectionString: config.get("DATABASE_URL", { infer: true }) }) });
  }

  async onModuleInit() {
    try {
      await this.$connect();
    } catch (e) {
      // Keep the API up so /health can report the problem instead of crash-looping.
      this.log.error(`Database unavailable at startup: ${e instanceof Error ? e.message : e}`);
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
