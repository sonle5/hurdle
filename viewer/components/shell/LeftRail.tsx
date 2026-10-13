"use client";

import { useCallback } from "react";
import Link from "next/link";
import { usePathname, useSearchParams, useRouter } from "next/navigation";
import { GitCompareArrows } from "lucide-react";
import { cn, formatModel } from "@/lib/utils";
import { VersionCombobox } from "@/components/ui/VersionCombobox";
import { SidebarFooter } from "./SidebarFooter";
import { SidebarToggle } from "./ResizableSidebarShell";
import { Brand } from "./Brand";

export type RailFilters = {
  versions: { id: string; name: string; description: string | null; kind?: "weekly" | "experiment" | "smoke" | null; runAt?: string | null; createdAt?: string | null; model?: string | null; ccVersion?: string | null }[];
  agents:   { slug: string; label: string; count: number }[];          // empty/1 ⇒ rail hides group
  models:   { id: string; label: string; count: number }[];            // empty/1 ⇒ rail hides group
  configs:  { id: string; label: string; count: number }[];
  tasks:    { slug: string; label: string; count: number; cli: boolean }[];
  runs:     { id: string; count: number }[];
  // current URL state for echoing in radios
  current: {
    version: string;
    agent:   string;     // "all" or a slug
    model:   string;     // a model alias (single-select; never "all" when >1 model)
    config:  string;     // "all" or a slug
    task:    string;     // "all" or a slug
    run:     string;     // "all" or a slug
    category: "all" | "general" | "cli";
  };
};

export function LeftRail({
  filters,
  collapsed,
  onCollapsedChange,
}: {
  filters: RailFilters;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const setParam = useCallback(
    (key: string, value: string | null) => {
      const params = new URLSearchParams(sp.toString());
      // Legacy: clear the old `harness` key whenever agent changes; we only
      // write `agent` going forward.
      if (key === "agent") params.delete("harness");
      // Category default is "general" — when the user picks it, omit the
      // param so a fresh URL is the default view. "all" and "cli" are
      // explicit because they differ from the default.
      if (key === "category") {
        if (value === "general" || value === null || value === "") params.delete(key);
        else params.set(key, value);
      } else if (key === "model") {
        // "all" is a meaningful explicit state for model (split view), so keep
        // it in the URL rather than deleting (delete would fall back to the
        // single-model default).
        if (value === null || value === "") params.delete(key);
        else params.set(key, value);
      } else {
        if (value === null || value === "all" || value === "") params.delete(key);
        else params.set(key, value);
      }
      const qs = params.toString();
      router.replace(qs ? `?${qs}` : "?", { scroll: false });
    },
    [router, sp],
  );

  // On task / session pages, the URL `task` param is meaningless — the page
  // *is* the task. Selecting a different task in the rail navigates instead.
  const isTaskPage = pathname?.startsWith("/t/") ?? false;
  const isSessionPage = pathname?.startsWith("/s/") ?? false;
  const isTaskScoped = isTaskPage || isSessionPage;

  const handleTaskChange = useCallback(
    (slug: string) => {
      if (!isTaskScoped) {
        setParam("task", slug);
        return;
      }
      const params = new URLSearchParams(sp.toString());
      params.delete("task");
      params.delete("tab"); // session-tab is page-specific
      const qs = params.toString();
      if (slug === "all") {
        router.push(qs ? `/?${qs}` : "/");
      } else {
        router.push(qs ? `/t/${encodeURIComponent(slug)}?${qs}` : `/t/${encodeURIComponent(slug)}`);
      }
    },
    [isTaskScoped, router, setParam, sp],
  );

  const setVersion = (id: string) => {
    const params = new URLSearchParams(sp.toString());
    if (pathname?.startsWith("/compare")) {
      params.delete("v");
      params.set("a", id);
    } else {
      params.set("v", id);
    }
    const qs = params.toString();
    router.push(`${pathname || "/"}${qs ? `?${qs}` : ""}`);
  };

  // Filter reset is reachable from the ContextBar chip strip ("Clear"
  // button + per-chip × dismissals), so the rail footer no longer carries
  // its own Reset button.

  const hasCli = filters.tasks.some((t) => t.cli);
  const hasGeneral = filters.tasks.some((t) => !t.cli);
  const filteredTasks = filters.tasks.filter((t) => {
    if (filters.current.category === "cli") return t.cli;
    if (filters.current.category === "general") return !t.cli;
    return true;
  });
  // Show the category switch when there's a real choice (both kinds present),
  // OR when the current category hides every task — an escape hatch so a
  // cli-only version stuck on "general" (e.g. via a stale URL) is never a dead
  // end with no visible way to switch.
  const showCategory = (hasCli && hasGeneral) || (filters.tasks.length > 0 && filteredTasks.length === 0);
  const compareHref = compareNavHref(filters);
  const compareActive = pathname?.startsWith("/compare") ?? false;

  if (collapsed) {
    return (
      <aside className="z-30 hidden h-full w-full shrink-0 flex-col items-center gap-1 bg-sidebar lg:flex">
        {/* The brand row spans y=8–56, the same band as the inset panel's top bar. */}
        <div className="flex h-12 w-full mt-2 items-center justify-center">
          <Brand collapsed />
        </div>
        <SidebarToggle collapsed={collapsed} onCollapsedChange={onCollapsedChange} />
      </aside>
    );
  }

  return (
    <aside className="z-30 hidden h-full w-full shrink-0 flex-col bg-sidebar lg:flex">
      {/* The brand row spans y=8–56, the same band as the inset panel's top
          bar, so the wordmark and the breadcrumbs share one centre line. The
          rail sits on the app chrome, so it needs no dividing borders. */}
      <div className="mt-2 flex h-12 shrink-0 items-center justify-between pl-5 pr-3">
        <Brand />
        <SidebarToggle collapsed={collapsed} onCollapsedChange={onCollapsedChange} />
      </div>

      {/* Groups fade under the brand row and the footer instead of being cut off. */}
      <div className="flex-1 overflow-y-auto px-3 pt-3 pb-4 space-y-5 [mask-image:linear-gradient(to_bottom,transparent,#000_12px,#000_calc(100%_-_16px),transparent)]">
        <RailGroup label="Review">
          <RailNavLink href={compareHref} active={compareActive} icon={<GitCompareArrows className="h-3.5 w-3.5" aria-hidden />}>
            Compare
          </RailNavLink>
        </RailGroup>

        {/* Version */}
        <RailGroup label="Version">
          <VersionCombobox
            value={filters.current.version}
            options={filters.versions}
            onChange={setVersion}
            ariaLabel="Version"
          />
          {(() => {
            const v = filters.versions.find((x) => x.id === filters.current.version);
            // Same model label the filters use ("Opus 5.5", "GPT-6.1-SOL").
            const model = formatModel(v?.model);
            const cc = v?.ccVersion;
            if (!model && !cc) return null;
            return (
              <div className="mt-1.5 px-2 text-[12px] text-fg-faint">
                {[model, cc ? `CC ${cc}` : null].filter(Boolean).join(" · ")}
              </div>
            );
          })()}
        </RailGroup>

        {/* Agent */}
        {filters.agents.length > 1 && (
          <RailGroup label="Agent">
            <RailRadio
              name="agent"
              value="all"
              current={filters.current.agent}
              onChange={(v) => setParam("agent", v)}
              count={filters.agents.reduce((s, a) => s + a.count, 0)}
            >All</RailRadio>
            {filters.agents.map((a) => (
              <RailRadio
                key={a.slug}
                name="agent"
                value={a.slug}
                current={filters.current.agent}
                onChange={(v) => setParam("agent", v)}
                count={a.count}
              >{a.label}</RailRadio>
            ))}
          </RailGroup>
        )}

        {/* Model — single-select (no "All"): a version can hold multiple models
            under one agent, and blending their pass-rates would be misleading.
            Hidden when a version has just one model. */}
        {filters.models.length > 1 && (
          <RailGroup label="Model">
            <RailRadio
              name="model"
              value="all"
              current={filters.current.model}
              onChange={(v) => setParam("model", v)}
              count={filters.models.reduce((s, m) => s + m.count, 0)}
            >All (split)</RailRadio>
            {filters.models.map((m) => (
              <RailRadio
                key={m.id}
                name="model"
                value={m.id}
                current={filters.current.model}
                onChange={(v) => setParam("model", v)}
                count={m.count}
              >{m.label}</RailRadio>
            ))}
          </RailGroup>
        )}

        {/* Config — hidden on task pages because the task view IS the
            side-by-side config comparison; a single-config filter there
            would either be a no-op or hide the comparison's whole point. */}
        {filters.configs.length > 1 && !isTaskPage && (
          <RailGroup label="Config">
            <RailRadio
              name="config"
              value="all"
              current={filters.current.config}
              onChange={(v) => setParam("config", v)}
              count={filters.configs.reduce((s, c) => s + c.count, 0)}
            >All</RailRadio>
            {filters.configs.map((c) => (
              <RailRadio
                key={c.id}
                name="config"
                value={c.id}
                current={filters.current.config}
                onChange={(v) => setParam("config", v)}
                count={c.count}
              >{c.label}</RailRadio>
            ))}
          </RailGroup>
        )}

        {/* Task — on task/session pages, the radios navigate rather than
            update a URL param (the page IS the task; updating a query
            string would do nothing visible). The "↗" hint reinforces. */}
        {filters.tasks.length > 1 && (
          <RailGroup
            label={isTaskScoped ? "Task ↗" : "Task"}
            adornment={
              showCategory ? (
                <div className="flex items-center gap-1 text-[11px]">
                  <CategoryChip current={filters.current.category} value="general" onClick={(v) => setParam("category", v)}>General</CategoryChip>
                  <CategoryChip current={filters.current.category} value="cli" onClick={(v) => setParam("category", v)}>CLI</CategoryChip>
                  <CategoryChip current={filters.current.category} value="all" onClick={(v) => setParam("category", v)}>All</CategoryChip>
                </div>
              ) : null
            }
          >
            <RailRadio
              name="task"
              value="all"
              current={filters.current.task}
              onChange={handleTaskChange}
              count={filteredTasks.reduce((s, t) => s + t.count, 0)}
            >
              {filters.current.category === "general" ? "General"
                : filters.current.category === "cli" ? "CLI"
                : "All"}
            </RailRadio>
            {filteredTasks.map((t) => (
              <RailRadio
                key={t.slug}
                name="task"
                value={t.slug}
                current={filters.current.task}
                onChange={handleTaskChange}
                count={t.count}
              >{t.label}</RailRadio>
            ))}
          </RailGroup>
        )}

        {/* Run */}
        {filters.runs.length > 1 && (
          <RailGroup label="Run">
            <RailRadio
              name="run"
              value="all"
              current={filters.current.run}
              onChange={(v) => setParam("run", v)}
              count={filters.runs.reduce((s, r) => s + r.count, 0)}
            >All</RailRadio>
            {filters.runs.map((r) => (
              <RailRadio
                key={r.id}
                name="run"
                value={r.id}
                current={filters.current.run}
                onChange={(v) => setParam("run", v)}
                count={r.count}
              >{r.id.replace("run", "Run ")}</RailRadio>
            ))}
          </RailGroup>
        )}
      </div>

      <SidebarFooter />
    </aside>
  );
}


function compareNavHref(filters: RailFilters): string {
  const params = new URLSearchParams();
  if (filters.current.version) params.set("a", filters.current.version);
  const query = params.toString();
  return query ? `/compare?${query}` : "/compare";
}

function RailGroup({ label, adornment, children }: { label: string; adornment?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-1 flex h-6 items-center justify-between px-2">
        <span className="meta-label">{label}</span>
        {adornment}
      </div>
      <div className="flex flex-col gap-px">{children}</div>
    </section>
  );
}

function RailNavLink({
  href,
  active,
  icon,
  children,
}: {
  href: string;
  active: boolean;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group flex h-7 items-center gap-2 rounded-md px-2 text-[13px] transition-colors",
        active
          ? "bg-sidebar-accent text-foreground font-medium"
          : "text-fg-muted hover:bg-sidebar-accent hover:text-foreground",
      )}
    >
      <span className={cn("shrink-0", active ? "text-foreground" : "text-fg-faint group-hover:text-foreground")}>
        {icon}
      </span>
      <span className="truncate">{children}</span>
    </Link>
  );
}


function RailRadio({
  name, value, current, onChange, count, children,
}: {
  name: string;
  value: string;
  current: string;
  onChange: (v: string) => void;
  count?: number;
  children: React.ReactNode;
}) {
  const active = current === value;
  return (
    <button
      type="button"
      onClick={() => onChange(value)}
      aria-pressed={active}
      data-active={active}
      className={cn(
        // Selection is a filled row, as in the nav above: one quiet fill for
        // "you are here", a lighter one under the pointer.
        "group flex h-7 items-center justify-between gap-2 rounded-md px-2 text-[13px] transition-colors text-left",
        active
          ? "bg-sidebar-accent text-foreground font-medium"
          : "text-fg-muted hover:bg-sidebar-accent/60 hover:text-foreground",
      )}
    >
      <span className="truncate">{children}</span>
      {typeof count === "number" && (
        <span className={cn("text-[12px] font-normal tabular-nums shrink-0", active ? "text-fg-muted" : "text-fg-faint")}>
          {count}
        </span>
      )}
    </button>
  );
}

function CategoryChip({
  current, value, onClick, children,
}: {
  current: string;
  value: "all" | "general" | "cli";
  onClick: (v: string) => void;
  children: React.ReactNode;
}) {
  const active = current === value;
  return (
    <button
      type="button"
      onClick={() => onClick(value)}
      data-active={active}
      className={cn(
        "rounded-[5px] px-1.5 py-0.5 transition-colors",
        active
          ? "bg-sidebar-accent text-foreground font-medium"
          : "text-fg-faint hover:text-foreground",
      )}
    >{children}</button>
  );
}
