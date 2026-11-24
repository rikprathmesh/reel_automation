import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { JwtModule } from "@nestjs/jwt";
import type { AppEnv } from "../config/env.ts";
import { AuthController } from "./auth.controller.ts";
import { AuthGuard } from "./auth.guard.ts";
import { AuthService } from "./auth.service.ts";

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppEnv, true>) => ({
        secret: config.get("JWT_SECRET", { infer: true }),
        signOptions: { expiresIn: config.get("JWT_TTL_HOURS", { infer: true }) * 3600, algorithm: "HS256" as const },
        verifyOptions: { algorithms: ["HS256" as const] },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, { provide: APP_GUARD, useClass: AuthGuard }],
  exports: [AuthService],
})
export class AuthModule {}
