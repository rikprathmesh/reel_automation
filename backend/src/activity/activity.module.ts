import { Global, Module } from "@nestjs/common";
import { ActivityService } from "./activity.service.ts";
import { ActivityController } from "./activity.controller.ts";

@Global()
@Module({ controllers: [ActivityController], providers: [ActivityService], exports: [ActivityService] })
export class ActivityModule {}
