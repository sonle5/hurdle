"use client";

import * as React from "react";
import { Combobox } from "@base-ui/react/combobox";
import { Check, ChevronsUpDown, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { evalVersionDisplayName } from "@/lib/version-display";

export type VersionComboboxOption = {
  id: string;
  name: string;
  description?: string | null;
  kind?: "weekly" | "experiment" | "smoke" | null;
  runAt?: string | null;
  createdAt?: string | null;
};

type Item = { value: string; label: string; sub: string | null; description: string | null };
type ItemGroup = { value: string; items: Item[] };

const versionDateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

function isWeeklyLike(option: VersionComboboxOption): boolean {
  if (option.kind) return option.kind === "weekly";
  return /^\d{4}-\d{2}-\d{2}$/.test(option.id) || /weekly/i.test(`${option.id} ${option.name}`);
}

function compareNewestFirst(a: VersionComboboxOption, b: VersionComboboxOption): number {
  const aTime = Date.parse(a.runAt ?? a.createdAt ?? "");
  const bTime = Date.parse(b.runAt ?? b.createdAt ?? "");
  if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) return bTime - aTime;
  if (Number.isFinite(aTime) !== Number.isFinite(bTime)) return Number.isFinite(bTime) ? 1 : -1;
  return b.id.localeCompare(a.id);
}

function formatVersionDate(option: VersionComboboxOption): string | null {
  const value = option.runAt ?? option.createdAt ?? (/^\d{4}-\d{2}-\d{2}$/.test(option.id) ? option.id : null);
  if (!value) return null;

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : versionDateFormatter.format(date);
}

function toItem(option: VersionComboboxOption): Item {
  const name = evalVersionDisplayName(option).trim();
  const date = formatVersionDate(option);
  const hasReadableName = Boolean(name && name !== option.id);

  return {
    value: option.id,
    label: hasReadableName ? name : (date ?? "Date unavailable"),
    sub: hasReadableName ? date : null,
    description: option.description?.trim() || null,
  };
}

function buildGroups(options: VersionComboboxOption[]): ItemGroup[] {
  const weeklies = options.filter(isWeeklyLike).sort(compareNewestFirst).map(toItem);
  const rest = options.filter((option) => !isWeeklyLike(option)).sort(compareNewestFirst).map(toItem);
  const groups: ItemGroup[] = [];
  if (weeklies.length > 0) groups.push({ value: "Weeklies", items: weeklies });
  if (rest.length > 0) groups.push({ value: "Experiments & probes", items: rest });
  return groups;
}

export function VersionCombobox({
  value,
  options,
  onChange,
  ariaLabel = "Version",
  className,
}: {
  value: string;
  options: VersionComboboxOption[];
  onChange: (id: string) => void;
  ariaLabel?: string;
  className?: string;
}) {
  const groups = React.useMemo(() => buildGroups(options), [options]);
  const selected = React.useMemo(
    () => groups.flatMap((group) => group.items).find((item) => item.value === value) ?? null,
    [groups, value],
  );

  return (
    <Combobox.Root
      items={groups}
      value={selected}
      isItemEqualToValue={(a, b) => a?.value === b?.value}
      filter={(item, query) => {
        const haystack = `${item.label} ${item.value} ${item.description ?? ""}`.toLocaleLowerCase();
        return haystack.includes(query.trim().toLocaleLowerCase());
      }}
      onValueChange={(item) => { if (item) onChange(item.value); }}
      autoHighlight
    >
      <Combobox.Trigger
        aria-label={ariaLabel}
        title={selected ? [selected.label, selected.sub].filter(Boolean).join(" · ") : undefined}
        className={cn(
          "flex h-8 w-full min-w-44 items-center justify-between gap-2 rounded-md border border-rule bg-background px-2 text-[12px] text-foreground",
          "hover:bg-surface focus-visible:outline-none focus-visible:border-foreground/40",
          className,
        )}
      >
        <span className="truncate tabular-nums">
          <Combobox.Value placeholder="Select version…" />
        </span>
        <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-fg-faint" aria-hidden />
      </Combobox.Trigger>
      <Combobox.Portal>
        <Combobox.Positioner sideOffset={4} align="start" className="z-50">
          <Combobox.Popup className="w-[360px] overflow-hidden rounded-md border border-rule bg-background shadow-xs outline-none">
            <div className="flex items-center gap-2 border-b border-rule px-2.5">
              <Search className="h-3.5 w-3.5 shrink-0 text-fg-faint" aria-hidden />
              <Combobox.Input
                placeholder="Search versions…"
                className="h-8 w-full bg-transparent text-[12px] text-foreground placeholder:text-fg-faint focus:outline-none"
              />
            </div>
            <Combobox.Empty className="px-3 py-6 text-center text-[12px] text-fg-muted empty:m-0 empty:p-0">
              No versions match.
            </Combobox.Empty>
            <Combobox.List className="max-h-72 overflow-y-auto p-1">
              {(group: ItemGroup) => (
                <Combobox.Group key={group.value} items={group.items}>
                  <Combobox.GroupLabel className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-fg-faint">
                    {group.value}
                  </Combobox.GroupLabel>
                  <Combobox.Collection>
                    {(item: Item) => (
                      <Combobox.Item
                        key={item.value}
                        value={item}
                        className="flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-[12px] text-foreground data-[highlighted]:bg-surface"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{item.label}</span>
                          {item.sub && <span className="block truncate text-[10px] tabular-nums text-fg-faint">{item.sub}</span>}
                          {item.description && <span className="mt-0.5 block truncate text-[10px] text-fg-muted">{item.description}</span>}
                        </span>
                        <Combobox.ItemIndicator className="shrink-0">
                          <Check className="h-3 w-3 text-foreground" aria-hidden />
                        </Combobox.ItemIndicator>
                      </Combobox.Item>
                    )}
                  </Combobox.Collection>
                </Combobox.Group>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
