import { Body, Controller, Get, HttpCode, Post, Req, Res } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Throttle } from "@nestjs/throttler";
import type { Request, Response } from "express";
import { z } from "zod";
import { zod } from "../common/zod.pipe.ts";
import type { AppEnv } from "../config/env.ts";
import { AuthService } from "./auth.service.ts";
import { SESSION_COOKIE } from "./auth.guard.ts";
import { CurrentUser, Public, type SessionUser } from "./decorators.ts";

const LoginBody = z.object({ email: z.string().email(), password: z.string().min(1).max(512) });
const PasswordBody = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(12).max(512) });

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService, private readonly config: ConfigService<AppEnv, true>) {}

  @Public()
  @Post("login")
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 } }) // brute-force protection: 5 attempts per minute per IP
  async login(@Body(zod(LoginBody)) body: z.infer<typeof LoginBody>, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { token, user } = await this.auth.login(body.email, body.password, req.ip ?? null);
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: this.config.get("NODE_ENV", { infer: true }) === "production",
      path: "/",
      maxAge: this.config.get("JWT_TTL_HOURS", { infer: true }) * 3_600_000,
    });
    return { user };
  }

  @Public()
  @Post("logout")
  @HttpCode(200)
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  }

  @Get("me")
  me(@CurrentUser() user: SessionUser) {
    return { user };
  }

  @Post("password")
  @HttpCode(200)
  async changePassword(@CurrentUser() user: SessionUser, @Body(zod(PasswordBody)) body: z.infer<typeof PasswordBody>) {
    await this.auth.changePassword(user.id, body.currentPassword, body.newPassword);
    return { ok: true };
  }
}
