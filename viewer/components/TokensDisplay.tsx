"use client";

import { ArrowUp, ArrowDown, BookOpen, PenLine } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { TokenUsage } from "@/lib/session-usage.mjs";

const formatTokens = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toString();
};

function TokenItem({ icon: Icon, value, label }: { icon: typeof ArrowUp; value: number; label: string }) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap" aria-label={`${label}: ${value.toLocaleString("en-US")} tokens`}>
      <Icon className="h-3 w-3 text-muted-foreground" aria-hidden />
      <span className="text-fg-muted">{label}</span>
      {formatTokens(value)}
    </span>
  );
}

export function AgentTokens({ total, usage, showTooltip = true }: { total: number | null; usage: TokenUsage | null; showTooltip?: boolean }) {
  if (total === null) return <span aria-label="Agent token usage is unavailable">—</span>;
  if (!showTooltip) return <span className="tabular-nums" aria-label={`${total.toLocaleString("en-US")} total agent tokens`}>{formatTokens(total)}</span>;
  return (
    <TooltipProvider delay={0}>
      <Tooltip>
        <TooltipTrigger render={<span />} className="cursor-default tabular-nums" aria-label={`${total.toLocaleString("en-US")} total agent tokens`}>
          {formatTokens(total)}
        </TooltipTrigger>
        <TooltipContent className="block">
          <div className="font-medium">Total agent tokens · {total.toLocaleString("en-US")}</div>
          {usage ? <dl className="mt-1 grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5 tabular-nums">
            {([["Uncached input", usage.input], ["Cache read", usage.cacheRead], ["Cache write", usage.cacheCreate], ["Output", usage.output]] as const).map(([label, value]) => (
              <div key={label} className="contents"><dt>{label}</dt><dd className="text-right">{value.toLocaleString("en-US")}</dd></div>
            ))}
          </dl> : <div className="mt-1">Breakdown unavailable</div>}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function TokensDisplay({ tokens }: { tokens: { input: number; output: number; cacheRead: number; cacheCreate: number } }) {
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 tabular-nums text-xs">
      <TokenItem icon={ArrowUp} value={tokens.input} label="Uncached input" />
      <TokenItem icon={ArrowDown} value={tokens.output} label="Output" />
      <TokenItem icon={BookOpen} value={tokens.cacheRead} label="Cache read" />
      <TokenItem icon={PenLine} value={tokens.cacheCreate} label="Cache write" />
    </span>
  );
}
