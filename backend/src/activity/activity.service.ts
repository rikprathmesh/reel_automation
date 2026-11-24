import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.ts";
import { EventsService } from "../events/events.service.ts";
import type { Prisma } from "../generated/prisma/client.ts";

export interface ActivityInput {
  entityType: string;
  entityId?: string | null;
  action: string;
  message: string;
  level?: "info" | "warn" | "error";
  actorUserId?: string | null;
  data?: Prisma.InputJsonValue;
  ip?: string | null;
}

/**
 * Durable audit trail. Every important operation calls record().
 * Never throws: a logging failure must not break the operation being logged.
 * Callers must not pass secrets (tokens, cookies, passwords) in message/data.
 */
@Injectable()
export class ActivityService {
  private readonly log = new Logger("Activity");

  constructor(private readonly prisma: PrismaService, private readonly events: EventsService) {}

  async record(a: ActivityInput): Promise<void> {
    const level = a.level ?? "info";
    const line = `[${a.entityType}${a.entityId ? ` ${a.entityId}` : ""}] ${a.action}: ${a.message}`;
    if (level === "error") this.log.error(line); else if (level === "warn") this.log.warn(line); else this.log.log(line);
    try {
      const row = await this.prisma.activityLog.create({
        data: { entityType: a.entityType, entityId: a.entityId ?? null, action: a.action, message: a.message, level, actorUserId: a.actorUserId ?? null, data: a.data, ip: a.ip ?? null },
        select: { id: true, entityType: true, entityId: true, action: true, level: true, message: true, createdAt: true },
      });
      this.events.emit("activity", row);
    } catch (e) {
      this.log.error(`Failed to persist activity: ${e instanceof Error ? e.message : e}`);
    }
  }
}
