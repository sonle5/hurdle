import { Bot, CheckCircle2, CircleMinus, XCircle } from "lucide-react";
import { Markdown } from "@/components/Markdown";
import {
  EvaluatorSourceDrawer,
  type EvaluatorSourceSummary,
} from "@/components/canonical/EvaluatorSourceDrawer";
import { cn } from "@/lib/utils";

export type CanonicalStoredCheck = {
  id: string;
  outcome: "pass" | "fail" | "skip";
  summary: string;
  authoredAuthority: string | null;
  effectiveAuthority: string | null;
  evidenceRefs: string[];
};

export type CanonicalJudgeReview = {
  verdict: string;
  summary: string | null;
  judgeId: string | null;
  model: string | null;
};

const OUTCOME_STYLE = {
  pass: {
    label: "Passed",
    className: "border-pass/30 bg-pass-faint text-pass",
    icon: CheckCircle2,
  },
  fail: {
    label: "Failed",
    className: "border-fail/30 bg-fail-faint text-fail",
    icon: XCircle,
  },
  skip: {
    label: "Skipped",
    className: "border-rule bg-surface text-fg-muted",
    icon: CircleMinus,
  },
} as const;

export function CanonicalSessionReview({
  prompt,
  checks,
  judge,
  runId,
  evaluatorSources,
}: {
  prompt: string;
  checks: CanonicalStoredCheck[];
  judge: CanonicalJudgeReview | null;
  runId: string | null;
  evaluatorSources: readonly EvaluatorSourceSummary[];
}) {
  const sourceAvailable = Boolean(runId && evaluatorSources.length > 0);

  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-lg border border-rule bg-background">
        <div className="border-b border-rule px-5 py-3.5">
          <h2 className="text-sm font-semibold text-foreground">Task</h2>
        </div>
        <div className="px-5 py-4">
          <div className="max-w-[75ch]">
            <Markdown content={prompt} />
          </div>
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border border-rule bg-background">
        <div className="flex items-center justify-between border-b border-rule px-5 py-3.5">
          <h2 className="text-sm font-semibold text-foreground">Evaluation checks</h2>
          <div className="flex items-center gap-3">
            {sourceAvailable && runId && (
              <EvaluatorSourceDrawer
                runId={runId}
                title="Evaluation checks"
                sources={evaluatorSources}
              />
            )}
            <span className="text-[11px] tabular-nums text-fg-faint">
              {checks.length} {checks.length === 1 ? "check" : "checks"}
            </span>
          </div>
        </div>
        {checks.length > 0 && !sourceAvailable && (
          <p className="border-b border-rule bg-surface/30 px-5 py-2 text-[11px] text-fg-faint">
            Evaluator source wasn&apos;t captured with this run. Run the evaluation again to inspect its exact code.
          </p>
        )}
        {checks.length > 0 ? (
          <div className="divide-y divide-rule">
            {checks.map((check) => {
              const style = OUTCOME_STYLE[check.outcome];
              const Icon = style.icon;
              const content = (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={cn(
                      "inline-flex h-5 items-center gap-1 rounded-full border px-1.5 text-[11px] font-medium leading-none",
                      style.className,
                    )}>
                      <Icon className="h-3 w-3" aria-hidden />
                      {style.label}
                    </span>
                    <code className="text-xs text-fg-muted">{check.id}</code>
                    {check.effectiveAuthority && (
                      <span className="text-[11px] capitalize text-fg-faint">
                        {check.effectiveAuthority}
                      </span>
                    )}
                  </div>
                  <p className="mt-2 max-w-[75ch] text-pretty text-sm leading-6 text-foreground/85">
                    {check.summary}
                  </p>
                </>
              );
              return (
                <div key={check.id} className="px-5 py-4">
                  {content}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="px-5 py-4 text-sm text-fg-muted">No evaluation checks were stored for this run.</p>
        )}
      </section>

      {judge && (
        <section className="overflow-hidden rounded-lg border border-rule bg-background">
          <div className="flex items-center justify-between border-b border-rule px-5 py-3.5">
            <div className="flex items-center gap-2">
              <Bot className="h-3.5 w-3.5 text-fg-muted" aria-hidden />
              <h2 className="text-sm font-semibold text-foreground">Judge review</h2>
            </div>
            <span className="text-[11px] capitalize text-fg-muted">{judge.verdict}</span>
          </div>
          <div className="space-y-2 px-5 py-4">
            {judge.summary && <p className="max-w-[75ch] text-pretty text-sm leading-6 text-foreground/85">{judge.summary}</p>}
            {(judge.judgeId || judge.model) && (
              <p className="font-mono text-[11px] text-fg-faint">
                {[judge.judgeId, judge.model].filter(Boolean).join(" · ")}
              </p>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
