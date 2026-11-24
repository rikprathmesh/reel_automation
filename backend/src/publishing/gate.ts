/**
 * The publishing approval gate as a pure decision function (unit-tested in test/gate.test.ts).
 * The worker loads these facts inside a locked SERIALIZABLE transaction and calls checkGate()
 * immediately before every upload. Returns null when publishing may proceed, otherwise the reason.
 */
export interface GateFacts {
  job: { status: string; platform: "youtube" | "instagram"; approvalId: string; alreadyPublished: boolean };
  version: { status: string };
  projectDeleted: boolean;
  /** All decisions on this version, any order. */
  decisions: { id: string; decision: "approved" | "rejected" | "changes_requested"; platforms: string[]; decidedAt: Date }[];
}

export type GateResult = { ok: true } | { ok: false; skip?: boolean; reason: string };

export function checkGate(f: GateFacts): GateResult {
  if (f.job.alreadyPublished) return { ok: false, skip: true, reason: "Already published (idempotent skip)" };
  if (!["queued", "scheduled"].includes(f.job.status)) return { ok: false, reason: `Job is "${f.job.status}"` };
  if (f.projectDeleted) return { ok: false, reason: "Project was deleted" };
  if (f.version.status !== "approved") return { ok: false, reason: `Version is "${f.version.status}", not approved` };
  const sorted = [...f.decisions].sort((a, b) => b.decidedAt.getTime() - a.decidedAt.getTime());
  const latest = sorted[0];
  if (!latest || latest.decision !== "approved") return { ok: false, reason: `Latest decision on this version is "${latest?.decision ?? "none"}"` };
  const linked = f.decisions.find((d) => d.id === f.job.approvalId);
  if (!linked || linked.decision !== "approved") return { ok: false, reason: "The job is not linked to an approval" };
  if (!linked.platforms.includes(f.job.platform)) return { ok: false, reason: `The approval does not cover ${f.job.platform}` };
  const negativeAfter = f.decisions.some((d) => d.decision !== "approved" && d.decidedAt > linked.decidedAt);
  if (negativeAfter) return { ok: false, reason: "The version was rejected or sent back after this approval" };
  return { ok: true };
}
