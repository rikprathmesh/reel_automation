import { Controller, Get, Query } from "@nestjs/common";
import { z } from "zod";
import { PrismaService } from "../prisma/prisma.service.ts";
import { zod } from "../common/zod.pipe.ts";

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  entityType: z.string().optional(),
  entityId: z.string().optional(),
});

@Controller("activity")
export class ActivityController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  list(@Query(zod(ListQuery)) q: z.infer<typeof ListQuery>) {
    return this.prisma.activityLog.findMany({
      where: { entityType: q.entityType, entityId: q.entityId },
      orderBy: { createdAt: "desc" },
      take: q.limit,
      select: { id: true, entityType: true, entityId: true, action: true, level: true, message: true, createdAt: true, actor: { select: { displayName: true } } },
    });
  }
}
