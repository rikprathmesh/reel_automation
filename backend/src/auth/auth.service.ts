import { Injectable, UnauthorizedException, type OnModuleInit } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import argon2 from "argon2";
import crypto from "node:crypto";
import { PrismaService } from "../prisma/prisma.service.ts";
import { ActivityService } from "../activity/activity.service.ts";
import type { SessionUser } from "./decorators.ts";

@Injectable()
export class AuthService implements OnModuleInit {
  /** Hash of a random secret, verified against when the email is unknown so response time doesn't reveal which emails exist. */
  private dummyHash = "";

  constructor(private readonly prisma: PrismaService, private readonly jwt: JwtService, private readonly activity: ActivityService) {}

  async onModuleInit() {
    this.dummyHash = await argon2.hash(crypto.randomBytes(32).toString("hex"), { type: argon2.argon2id });
  }

  async login(email: string, password: string, ip: string | null): Promise<{ token: string; user: SessionUser }> {
    const normalized = email.trim().toLowerCase();
    const user = await this.prisma.user.findFirst({ where: { email: normalized, deletedAt: null } });
    const ok = await argon2.verify(user?.passwordHash ?? this.dummyHash, password).catch(() => false);
    if (!user || !ok) {
      await this.activity.record({ entityType: "auth", action: "login_failed", level: "warn", message: `Failed sign-in for ${normalized}`, ip });
      throw new UnauthorizedException("Invalid email or password");
    }
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await this.activity.record({ entityType: "auth", entityId: user.id, action: "login", message: `${user.email} signed in`, actorUserId: user.id, ip });
    const session: SessionUser = { id: user.id, email: user.email, role: user.role, displayName: user.displayName };
    return { token: await this.jwt.signAsync({ sub: user.id }), user: session };
  }

  /** Resolves a token to a live user; deleted users and role changes take effect immediately. */
  async verify(token: string): Promise<SessionUser | null> {
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string }>(token);
      return await this.prisma.user.findFirst({ where: { id: payload.sub, deletedAt: null }, select: { id: true, email: true, role: true, displayName: true } });
    } catch {
      return null;
    }
  }

  async changePassword(userId: string, current: string, next: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!(await argon2.verify(user.passwordHash, current))) throw new UnauthorizedException("Current password is incorrect");
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash: await argon2.hash(next, { type: argon2.argon2id }) } });
    await this.activity.record({ entityType: "auth", entityId: userId, action: "password_changed", message: "Password changed", actorUserId: userId });
  }
}
