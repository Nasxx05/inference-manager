import { Bot, CircleDot, GitBranch, Layers3, Route, ShieldAlert, Users, WalletCards } from "lucide-react";
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
  const budgetPercent = usage.budget > 0 ? Math.min(100, (usage.used / usage.budget) * 100) : 0;
  const activeModel = [...snapshot.messages].reverse().find((message) => message.role === "assistant" && message.modelRoute?.chosenModel)?.modelRoute?.chosenModel;
  const changedRequirements = memory.requirements.filter((item) => item.briefChangeStatus).slice(-5).reverse();
  return (
    <aside className="h-full overflow-y-auto border-l border-line bg-paper px-5 py-6">
      <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted">Project memory</p>
      <h2 className="mt-2 text-sm font-semibold">What Promgent currently understands</h2>

      <section className="mt-6">
        <div className="mb-2 flex items-center gap-2 text-xs font-medium"><CircleDot className="h-3.5 w-3.5 text-forest" /> Phase</div>
        <span className="inline-flex rounded-full bg-forest-light px-2.5 py-1 font-mono text-[10px] uppercase tracking-wide text-forest">{phase.replaceAll("_", " ")}</span>
      </section>

      <section className="mt-6">
        <div className="mb-2 flex items-center gap-2 text-xs font-medium"><Bot className="h-3.5 w-3.5 text-forest" /> Active model</div>
        <p className="break-all font-mono text-[10px] leading-4 text-muted">{activeModel ?? (project.selectedModel === "auto" ? "Auto — selected per turn" : project.selectedModel)}</p>
      </section>

      <section className="mt-6">
        <h3 className="mb-2 text-xs font-medium">Goal</h3>
        <p className="text-xs leading-5 text-muted">{memory.purpose || project.initialDescription}</p>
      </section>

      {changedRequirements.length ? <section className="mt-6">
        <h3 className="mb-2 text-xs font-medium">Latest brief changes</h3>
        <ul className="space-y-2">{changedRequirements.map((item) => <li key={item.id} className="text-xs leading-5 text-muted"><span className={`mr-1.5 rounded px-1.5 py-0.5 font-mono text-[8px] uppercase ${item.briefChangeStatus === "removed" ? "bg-danger-light text-danger" : item.briefChangeStatus === "new" ? "bg-forest-light text-forest" : "bg-credit-light text-credit"}`}>{item.briefChangeStatus}</span>{item.description}</li>)}</ul>
      </section> : null}

      <section className="mt-6">
        <div className="mb-2 flex items-center gap-2 text-xs font-medium"><Users className="h-3.5 w-3.5 text-forest" /> Primary users</div>
        <List values={memory.users} empty="Promgent still needs to identify the primary user." />
      </section>

      <section className="mt-6">
        <div className="mb-2 flex items-center gap-2 text-xs font-medium"><Layers3 className="h-3.5 w-3.5 text-forest" /> Confirmed scope</div>
        <List values={memory.mvpScope?.length ? memory.mvpScope : memory.requirements.filter((item) => item.status === "confirmed").map((item) => item.description)} empty="Scope is still being shaped in the conversation." />
      </section>

      <section className="mt-6">
        <div className="mb-2 flex items-center gap-2 text-xs font-medium"><Route className="h-3.5 w-3.5 text-forest" /> User journeys</div>
        <List values={[...(memory.workflows ?? []), ...(memory.adminWorkflows ?? [])]} empty="The end-to-end success journey is not yet clear." />
      </section>

      <section className="mt-6">
        <h3 className="mb-2 text-xs font-medium">Current architecture</h3>
        <p className="text-xs leading-5 text-muted">{memory.architectureSummary || "Architecture has not changed from the initial product shape yet."}</p>
      </section>

      <section className="mt-6">
        <div className="mb-2 flex items-center gap-2 text-xs font-medium"><ShieldAlert className="h-3.5 w-3.5 text-credit" /> Risks and constraints</div>
        <List values={[...memory.risks, ...(memory.constraints ?? [])]} empty="No project-specific risk is recorded yet." />
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

      <section className="mt-6 rounded-lg border border-line bg-canvas p-3">
        <div className="flex items-center justify-between gap-3"><h3 className="text-xs font-medium">Engineering CREDIT</h3><span className="font-mono text-[9px] uppercase text-muted">{usage.estimated ? "Includes estimates" : "Provider charges"}</span></div>
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-line"><div className="h-full rounded-full bg-forest" style={{ width: `${budgetPercent}%` }} /></div>
        {usage.budget > 0 && usage.remaining / usage.budget <= 0.1 ? <p className="mt-2 rounded bg-credit-light px-2 py-1.5 text-[10px] leading-4 text-credit">This interview is near its CREDIT limit. Keep the next turn focused or increase the project budget.</p> : null}
        <div className="mt-3 grid grid-cols-3 gap-2">
          <div><p className="font-mono text-sm">{usage.used.toFixed(3)}</p><p className="text-[9px] text-muted">Used</p></div>
          <div><p className="font-mono text-sm">{usage.remaining.toFixed(3)}</p><p className="text-[9px] text-muted">Budget left</p></div>
          <div><p className="font-mono text-sm">{usage.budget.toFixed(2)}</p><p className="text-[9px] text-muted">Project limit</p></div>
        </div>
        {usage.events.length ? <div className="mt-3 border-t border-line pt-2"><p className="mb-1 text-[9px] uppercase tracking-wide text-muted">Recent turns</p>{usage.events.slice(-3).reverse().map((event, index) => <div key={`${event.createdAt}-${index}`} className="flex items-center justify-between gap-2 py-1 text-[10px] text-muted"><span className="truncate">{event.phase.replaceAll("_", " ")}</span><span className="shrink-0 font-mono">{event.cost.toFixed(4)}</span></div>)}</div> : null}
      </section>

      <section className="mt-2 grid grid-cols-2 gap-2">
        <div className="col-span-2 rounded-md border border-line bg-forest-light/40 p-3">
          <WalletCards className="h-3.5 w-3.5 text-forest" />
          <p className="mt-2 font-mono text-sm">{balance ? balance.available.toFixed(3) : "—"}</p>
          <p className="text-[10px] text-muted">Available {balance?.currency ?? "CREDIT"}</p>
        </div>
        <div className="col-span-2 rounded-md border border-line p-3">
          <GitBranch className="h-3.5 w-3.5 text-muted" />
          <p className="mt-2 truncate text-xs">{memory.currentReviewedCommit?.slice(0, 8) ?? "Not linked"}</p>
          <p className="text-[10px] text-muted">Reviewed commit</p>
        </div>
      </section>
    </aside>
  );
}
