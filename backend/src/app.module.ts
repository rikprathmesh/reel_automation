import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { ConfigModule } from "@nestjs/config";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { validateEnv } from "./config/env.ts";
import { ErrorsFilter } from "./common/errors.filter.ts";
import { PrismaModule } from "./prisma/prisma.module.ts";
import { RedisModule } from "./redis/redis.module.ts";
import { EventsModule } from "./events/events.module.ts";
import { ActivityModule } from "./activity/activity.module.ts";
import { StorageModule } from "./storage/storage.module.ts";
import { AuthModule } from "./auth/auth.module.ts";
import { HealthModule } from "./health/health.module.ts";
import { QueuesModule } from "./queues/queues.module.ts";
import { ProvidersModule } from "./providers/providers.module.ts";
import { CharactersModule } from "./characters/characters.module.ts";
import { ReferencesModule } from "./references/references.module.ts";
import { ContentModule } from "./content/content.module.ts";
import { SettingsModule } from "./settings/settings.module.ts";
import { StoriesModule } from "./stories/stories.module.ts";
import { ProductionModule } from "./production/production.module.ts";
import { ReviewModule } from "./review/review.module.ts";
import { PublishingModule } from "./publishing/publishing.module.ts";
import { FlowModule } from "./flow/flow.module.ts";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, cache: true, validate: validateEnv, envFilePath: [".env"] }),
    // general API rate limit; login has its own stricter limit
    ThrottlerModule.forRoot([{ name: "default", ttl: 60_000, limit: 300 }]),
    PrismaModule,
    RedisModule,
    EventsModule,
    ActivityModule,
    StorageModule,
    AuthModule,
    HealthModule,
    QueuesModule,
    ProvidersModule,
    CharactersModule,
    ReferencesModule,
    ContentModule,
    SettingsModule,
    StoriesModule,
    ProductionModule,
    ReviewModule,
    PublishingModule,
    FlowModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_FILTER, useClass: ErrorsFilter },
  ],
})
export class AppModule {}
