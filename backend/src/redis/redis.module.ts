import { Global, Inject, Injectable, Logger, Module, type OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Redis } from "ioredis";
import type { AppEnv } from "../config/env.ts";

export const REDIS = Symbol("REDIS");

@Injectable()
class RedisLifecycle implements OnModuleDestroy {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}
  async onModuleDestroy() {
    this.redis.disconnect();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppEnv, true>) => {
        const log = new Logger("Redis");
        // BullMQ requires maxRetriesPerRequest: null on shared connections.
        const client = new Redis(config.get("REDIS_URL", { infer: true }), { maxRetriesPerRequest: null, lazyConnect: false });
        let warned = false;
        client.on("error", (e) => {
          if (!warned) log.error(`Redis error: ${e.message}`);
          warned = true;
        });
        client.on("ready", () => { warned = false; log.log("connected"); });
        return client;
      },
    },
    RedisLifecycle,
  ],
  exports: [REDIS],
})
export class RedisModule {}
