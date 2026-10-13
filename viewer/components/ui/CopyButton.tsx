"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

export function CopyButton({
  value,
  label,
  ariaLabel,
  copiedLabel = "Copied",
  size = "sm",
  className,
}: {
  value: string;
  label?: React.ReactNode;
  ariaLabel?: string;
  copiedLabel?: string;
  size?: "sm" | "xs";
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      // Older browsers / insecure contexts — fall back silently.
    }
  };

  const sizeClass = size === "xs"
    ? "px-1.5 py-0.5 text-[11px] gap-1"
    : "px-2 py-1 text-[11px] gap-1.5";

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel ?? (typeof label === "string" ? `Copy ${label}` : "Copy")}
      className={cn(
        "inline-flex items-center rounded-md border border-rule bg-background text-fg-muted hover:text-foreground transition-colors",
        sizeClass,
        className,
      )}
    >
      {copied ? (
        <>
          <Check className="h-3 w-3 text-pass" aria-hidden />
          <span>{copiedLabel}</span>
        </>
      ) : (
        <>
          <Copy className="h-3 w-3" aria-hidden />
          {label && <span>{label}</span>}
        </>
      )}
    </button>
  );
}
