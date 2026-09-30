import { CircleDot, GitBranch, Layers3, WalletCards } from "lucide-react";
import type { GuidedProjectSnapshot } from "@/types/project";

function List({ values, empty }: { values?: string[]; empty: string }) {
  const visible = values?.filter(Boolean).slice(0, 5) ?? [];
  return visible.length ? (
    <ul className="space-y-1.5 text-xs leading-5 text-muted">
      {visible.map((value) => <li key={value}>• {value}</li>)}
    </ul>
  ) : <p className="text-xs leading-5 text-muted">{empty}</p>;
}

export function ProjectContextPanel({ snapshot, balance }: { snapshot: GuidedProjectSnapshot; balance?: { available: number; currency: string } | null }) {
  const { project, memory, usage } = snapshot;
  const phase = memory.projectPhase ?? project.phase ?? "exploring";
  const next = memory.nextRecommendedAction ?? project.nextRecommendedAction;
  return (
    <aside className="h-full overflow-y-auto border-l border-line bg-paper px-5 py-6">
      <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted">Project memory</p>
      <h2 className="mt-2 text-sm font-semibold">What Promgent currently understands</h2>

      <section className="mt-6">
        <div className="mb-2 flex items-center gap-2 text-xs font-medium"><CircleDot className="h-3.5 w-3.5 text-forest" /> Phase</div>
        <span className="inline-flex rounded-full bg-forest-light px-2.5 py-1 font-mono text-[10px] uppercase tracking-wide text-forest">{phase.replaceAll("_", " ")}</span>
      </section>

      <section className="mt-6">
        <h3 className="mb-2 text-xs font-medium">Goal</h3>
        <p className="text-xs leading-5 text-muted">{memory.purpose || project.initialDescription}</p>
      </section>

      <section className="mt-6">
        <div className="mb-2 flex items-center gap-2 text-xs font-medium"><Layers3 className="h-3.5 w-3.5 text-forest" /> Confirmed scope</div>
        <List values={memory.mvpScope?.length ? memory.mvpScope : memory.requirements.filter((item) => item.status === "confirmed").map((item) => item.description)} empty="Scope is still being shaped in the conversation." />
      </section>

      <section className="mt-6">
        <div className="mb-2 flex items-center justify-between gap-2"><h3 className="text-xs font-medium">Stack</h3>{(memory.confirmedStack?.length || memory.proposedStack?.length) ? <span className={`rounded-full px-2 py-0.5 font-mono text-[9px] uppercase ${memory.confirmedStack?.length ? "bg-forest-light text-forest" : "bg-credit-light text-credit"}`}>{memory.confirmedStack?.length ? "Confirmed" : "Promgent recommendation"}</span> : null}</div>
        <List values={memory.confirmedStack?.length ? memory.confirmedStack : memory.proposedStack} empty="No stack decision yet." />
      </section>

      <section className="mt-6">
        <h3 className="mb-2 text-xs font-medium">Open decisions</h3>
        <List values={memory.openQuestions?.filter((item) => !item.resolved).map((item) => item.question)} empty="No open decisions right now." />
      </section>

      <section className="mt-6 rounded-lg border border-line bg-canvas p-3">
        <h3 className="text-xs font-medium">Recommended next</h3>
        <p className="mt-1 text-xs leading-5 text-muted">{next?.label ?? "Continue describing what you want to build."}</p>
        {next?.reason ? <p className="mt-1 text-[11px] leading-4 text-muted/80">{next.reason}</p> : null}
      </section>

      <section className="mt-6 grid grid-cols-2 gap-2">
        <div className="col-span-2 rounded-md border border-line bg-forest-light/40 p-3">
          <WalletCards className="h-3.5 w-3.5 text-forest" />
          <p className="mt-2 font-mono text-sm">{balance ? balance.available.toFixed(3) : "—"}</p>
          <p className="text-[10px] text-muted">Available {balance?.currency ?? "CREDIT"}</p>
        </div>
        <div className="rounded-md border border-line p-3">
          <WalletCards className="h-3.5 w-3.5 text-credit" />
          <p className="mt-2 font-mono text-sm">{usage.used.toFixed(3)}</p>
          <p className="text-[10px] text-muted">Conversation CREDIT used</p>
        </div>
        <div className="rounded-md border border-line p-3">
          <GitBranch className="h-3.5 w-3.5 text-muted" />
          <p className="mt-2 truncate text-xs">{memory.currentReviewedCommit?.slice(0, 8) ?? "Not linked"}</p>
          <p className="text-[10px] text-muted">Reviewed commit</p>
        </div>
      </section>
    </aside>
  );
}
