import { SetMetadata, createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { Request } from "express";

export const IS_PUBLIC = "isPublic";
/** Opt a route out of authentication (login, health). Everything else is protected by default. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export type Role = "owner" | "editor" | "viewer";
export const ROLES = "roles";
/** Restrict a route to specific roles. Without it, any signed-in user may call it. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);

export interface SessionUser { id: string; email: string; role: Role; displayName: string }

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): SessionUser => {
  return ctx.switchToHttp().getRequest<Request & { user: SessionUser }>().user;
});
