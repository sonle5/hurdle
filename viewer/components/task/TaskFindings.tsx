export function TaskFindings({ findings }: { findings?: string | null }) {
  if (!findings || !findings.trim()) return null;
  return (
    <section className="rounded-lg border border-rule bg-background overflow-hidden">
      <header className="px-5 py-3 border-b border-rule">
        <h2 className="text-[13px] font-semibold text-foreground">Findings</h2>
        <p className="text-[11px] text-fg-faint mt-0.5">What we&apos;ve learned about this task across configs.</p>
      </header>
      <p className="px-5 py-4 text-[12px] text-foreground/85 leading-relaxed whitespace-pre-wrap">
        {findings.trim()}
      </p>
    </section>
  );
}
