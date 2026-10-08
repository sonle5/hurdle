"use client";

import { ArrowUp, ArrowDown, BookOpen, PenLine } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

const formatTokens = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toString();
};

function TokenItem({ icon: Icon, value, label }: { icon: typeof ArrowUp; value: number; label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger className="inline-flex items-center gap-1 cursor-default">
        <Icon className="h-3 w-3 text-muted-foreground" />
        {formatTokens(value)}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function TokensDisplay({ tokens }: { tokens: { input: number; output: number; cacheRead: number; cacheCreate: number } }) {
  return (
    <TooltipProvider delay={0}>
      <span className="inline-flex items-center gap-3 flex-wrap tabular-nums text-sm">
        <TokenItem icon={ArrowUp} value={tokens.input} label="Uncached input tokens" />
        <TokenItem icon={ArrowDown} value={tokens.output} label="Output tokens" />
        <TokenItem icon={BookOpen} value={tokens.cacheRead} label="Cache read tokens" />
        <TokenItem icon={PenLine} value={tokens.cacheCreate} label="Cache write tokens" />
      </span>
    </TooltipProvider>
  );
}
