import { BadRequestException, Injectable, type PipeTransform } from "@nestjs/common";
import type { z } from "zod";

/** Validates request bodies/queries against a zod schema; 400 with readable messages on failure. */
@Injectable()
export class ZodPipe<S extends z.ZodType> implements PipeTransform<unknown, z.infer<S>> {
  constructor(private readonly schema: S) {}
  transform(value: unknown): z.infer<S> {
    const r = this.schema.safeParse(value ?? {});
    if (!r.success) {
      throw new BadRequestException(r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
    }
    return r.data;
  }
}

export const zod = <S extends z.ZodType>(schema: S) => new ZodPipe(schema);
