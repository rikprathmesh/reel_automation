import { Controller, Get, Req, Res } from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import type { Request, Response } from "express";
import { EventsService } from "./events.service.ts";

/** Server-Sent Events stream for live job progress and activity. */
@Controller("events")
@SkipThrottle()
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Get()
  stream(@Req() req: Request, @Res() res: Response) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 3000\n\n");
    const off = this.events.subscribe((e) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`));
    const heartbeat = setInterval(() => res.write(`: ping\n\n`), 20_000);
    req.on("close", () => {
      clearInterval(heartbeat);
      off();
    });
  }
}
