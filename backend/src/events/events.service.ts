import { Inject, Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
import { EventEmitter } from "node:events";
import { Redis } from "ioredis";
import { REDIS } from "../redis/redis.module.ts";

export type LiveEventType = "project" | "job" | "reference" | "story" | "character" | "publishing" | "activity";
export interface LiveEvent { type: LiveEventType; data: unknown }

const CHANNEL = "reelforge:events";

/**
 * Live dashboard events. Workers may run in other processes, so events go through
 * Redis pub/sub and fan out locally to every open SSE connection.
 */
@Injectable()
export class EventsService implements OnModuleDestroy {
  private readonly log = new Logger("Events");
  private readonly bus = new EventEmitter();
  private sub: Redis | null = null;

  constructor(@Inject(REDIS) private readonly redis: Redis) {
    this.bus.setMaxListeners(500);
  }

  emit(type: LiveEventType, data: unknown): void {
    this.redis.publish(CHANNEL, JSON.stringify({ type, data } satisfies LiveEvent)).catch((e: unknown) => {
      this.log.warn(`publish failed: ${e instanceof Error ? e.message : e}`);
    });
  }

  subscribe(listener: (e: LiveEvent) => void): () => void {
    this.ensureSubscribed();
    this.bus.on("event", listener);
    return () => this.bus.off("event", listener);
  }

  private ensureSubscribed() {
    if (this.sub) return;
    this.sub = this.redis.duplicate();
    void this.sub.subscribe(CHANNEL);
    this.sub.on("message", (_c: string, msg: string) => {
      try { this.bus.emit("event", JSON.parse(msg) as LiveEvent); } catch { /* ignore malformed */ }
    });
  }

  onModuleDestroy() {
    this.sub?.disconnect();
  }
}
