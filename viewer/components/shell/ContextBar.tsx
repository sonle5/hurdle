"use client";

import Link from "next/link";
import { usePathname, useSearchParams, useRouter } from "next/navigation";
import { ChevronRight, X } from "lucide-react";

const KNOWN_PARAMS = ["agent", "harness", "config", "task", "run", "category"] as const;

type Breadcrumb = { label: string; href?: string };

export function ContextBar({
  versionLabel,
  agentLabel,
  taskLabel,
  sessionLabel,
}: {
  versionLabel?: string;
  agentLabel?: Record<string, string>;
  taskLabel?: Record<string, string>;
  sessionLabel?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  const removeParam = (key: string) => {
    const p = new URLSearchParams(sp.toString());
    p.delete(key);
    // Legacy: clearing the agent chip should also drop the older `harness` key.
    if (key === "agent") p.delete("harness");
    const qs = p.toString();
    router.replace((pathname || "") + (qs ? `?${qs}` : ""), { scroll: false });
  };

  const resetAll = () => {
    const p = new URLSearchParams();
    const v = sp.get("v");
    if (v) p.set("v", v);
    router.replace((pathname || "") + (p.toString() ? `?${p.toString()}` : ""), { scroll: false });
  };

  // Crumb derivation: /, /t/<slug>, /s/<id>
  let crumbs: Breadcrumb[] = [{ label: "Leaderboard", href: "/" }];
  if (pathname?.startsWith("/t/")) {
    const slug = decodeURIComponent(pathname.slice(3));
    crumbs.push({ label: taskLabel?.[slug] || slug });
  } else if (pathname?.startsWith("/s/")) {
    crumbs.push({ label: sessionLabel || "Session" });
  } else if (pathname?.startsWith("/compare")) {
    crumbs.push({ label: "Compare" });
  }

  // Active chips
  const chips: { key: string; value: string; label: string }[] = [];
  for (const key of KNOWN_PARAMS) {
    const v = sp.get(key);
    if (!v || v === "all") continue;
    let label: string = v;
    if (key === "agent" || key === "harness") label = agentLabel?.[v] || v;
    if (key === "task") label = taskLabel?.[v] || v;
    if (key === "run") label = v.replace("run", "Run ");
    if (key === "category") label = v === "cli" ? "CLI" : "General";
    chips.push({ key: key === "harness" ? "agent" : key, value: v, label: `${labelForKey(key)}: ${label}` });
  }

  const hasFilters = chips.length > 0;

  return (
    <div className="sticky top-0 z-20 -mx-4 sm:-mx-6 lg:-mx-8 border-b border-rule bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="flex h-12 items-center gap-3 px-4 sm:px-6 lg:px-8">
        {/* Breadcrumb */}
        <nav className="flex items-center gap-1 min-w-0">
          {crumbs.map((c, i) => (
            <span key={i} className="inline-flex items-center gap-1 min-w-0">
              {i > 0 && <ChevronRight className="h-3 w-3 text-fg-faint shrink-0" />}
              {c.href ? (
                <Link href={c.href} className="text-[12px] text-fg-muted hover:text-foreground transition-colors truncate">
                  {c.label}
                </Link>
              ) : (
                <span className="text-[12px] font-medium text-foreground truncate">{c.label}</span>
              )}
            </span>
          ))}
          {versionLabel && (
            <span className="ml-2 inline-flex items-center gap-1 rounded-sm border border-rule px-1.5 py-0.5 text-[10px] font-mono text-fg-muted">
              {versionLabel}
            </span>
          )}
        </nav>

        {/* Active filter chips */}
        <div className="flex-1 min-w-0 overflow-x-auto">
          {hasFilters && (
            <div className="flex items-center gap-1.5">
              {chips.map((c) => (
                <button
                  key={`${c.key}:${c.value}`}
                  onClick={() => removeParam(c.key)}
                  className="group inline-flex items-center gap-1 rounded-md border border-rule bg-background px-2 py-0.5 text-[11px] text-fg-muted hover:text-foreground hover:border-foreground/40 transition-colors"
                >
                  <span>{c.label}</span>
                  <X className="h-3 w-3 shrink-0 text-fg-faint group-hover:text-foreground" />
                </button>
              ))}
            </div>
          )}
        </div>

        {hasFilters && (
          <button
            onClick={resetAll}
            className="shrink-0 text-[11px] text-fg-muted hover:text-foreground transition-colors"
          >
            Clear
          </button>
        )}

      </div>
    </div>
  );
}

function labelForKey(k: string): string {
  switch (k) {
    case "agent":
    case "harness": return "Agent";
    case "config": return "Config";
    case "task": return "Task";
    case "run": return "Run";
    case "category": return "Category";
  }
  return k;
}
