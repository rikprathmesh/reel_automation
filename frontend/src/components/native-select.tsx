import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** Styled native <select>: accessible, keyboard-friendly and predictable value handling. */
export function NativeSelect({ className, ...props }: ComponentProps<"select">) {
  return (
    <select
      className={cn(
        "h-8 w-full rounded-lg border border-input bg-input/30 px-2.5 text-sm text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 [&>option]:bg-popover",
        className,
      )}
      {...props}
    />
  );
}
