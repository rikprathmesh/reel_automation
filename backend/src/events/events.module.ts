import { Global, Module } from "@nestjs/common";
import { EventsController } from "./events.controller.ts";
import { EventsService } from "./events.service.ts";

@Global()
@Module({ controllers: [EventsController], providers: [EventsService], exports: [EventsService] })
export class EventsModule {}
