import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { AuthService } from "./auth.service.ts";
import { IS_PUBLIC, ROLES, type Role, type SessionUser } from "./decorators.ts";

export const SESSION_COOKIE = "rf_session";

/** Global guard: every route needs a valid session unless marked @Public(); @Roles() narrows further. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly auth: AuthService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;
    const req = ctx.switchToHttp().getRequest<Request & { user?: SessionUser; cookies?: Record<string, string> }>();
    const token = req.cookies?.[SESSION_COOKIE] ?? req.headers.authorization?.replace(/^Bearer\s+/i, "");
    const user = token ? await this.auth.verify(token) : null;
    if (!user) throw new UnauthorizedException("Sign in required");
    req.user = user;
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES, targets);
    if (roles?.length && !roles.includes(user.role)) throw new ForbiddenException("Your role can't perform this action");
    return true;
  }
}
