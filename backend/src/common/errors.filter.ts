import { ArgumentsHost, Catch, HttpException, HttpStatus, Logger, type ExceptionFilter } from "@nestjs/common";
import type { Response } from "express";
import { ProviderUnavailableError } from "../providers/types.ts";

interface PrismaLikeError { code?: string; meta?: unknown; name?: string; message: string }

/**
 * Uniform JSON errors: { error, statusCode }.
 * Known Prisma errors become 404/409 instead of 500; unexpected errors are logged with stack
 * but only a generic message reaches the client (no internals leak).
 */
@Catch()
export class ErrorsFilter implements ExceptionFilter {
  private readonly log = new Logger("Errors");

  catch(err: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    if (err instanceof HttpException) {
      const body = err.getResponse();
      const message = typeof body === "string" ? body : ((body as { message?: string | string[] }).message ?? err.message);
      return res.status(err.getStatus()).json({ statusCode: err.getStatus(), error: Array.isArray(message) ? message.join("; ") : message });
    }
    if (err instanceof ProviderUnavailableError) {
      return res.status(HttpStatus.SERVICE_UNAVAILABLE).json({ statusCode: 503, error: err.message });
    }
    const p = err as PrismaLikeError;
    if (p?.code === "P2025") return res.status(404).json({ statusCode: 404, error: "Not found" });
    if (p?.code === "P2002") return res.status(409).json({ statusCode: 409, error: "Already exists" });
    if (p?.code === "P2003") return res.status(409).json({ statusCode: 409, error: "Referenced by other records" });
    this.log.error(p?.message ?? String(err), (err as Error)?.stack);
    return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ statusCode: 500, error: "Internal server error" });
  }
}
