import type { ReactNode } from "react";
import { Construction } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions}
    </div>
  );
}

/** Honest placeholder for sections whose backend isn't built yet — no fake data, no dead buttons. */
export function PlannedSection({ title, description, phase, features }: { title: string; description: string; phase: string; features: string[] }) {
  return (
    <>
      <PageHeader title={title} description={description} />
      <Card>
        <CardContent className="flex flex-col gap-4 py-8">
          <div className="flex items-center gap-3">
            <div className="grid size-10 place-items-center rounded-lg bg-primary/15 text-primary"><Construction className="size-5" /></div>
            <div>
              <div className="font-medium">Planned for {phase}</div>
              <div className="text-sm text-muted-foreground">This section appears here once its backend is built and tested.</div>
            </div>
          </div>
          <ul className="grid gap-2 text-sm text-muted-foreground sm:grid-cols-2">
            {features.map((f) => (
              <li key={f} className="flex gap-2"><span className="text-primary">•</span>{f}</li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </>
  );
}
