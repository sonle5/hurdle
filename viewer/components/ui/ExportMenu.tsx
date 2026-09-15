"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Download } from "lucide-react";
import { cn } from "@/lib/utils";

export type ExportFormat = "csv" | "json";

export function ExportMenu({
  filenameBase,
  onExport,
  className,
}: {
  filenameBase: string;
  onExport: (fmt: ExportFormat) => { mime: string; content: string };
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const trigger = async (fmt: ExportFormat) => {
    const { mime, content } = onExport(fmt);
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${filenameBase}.${fmt}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setOpen(false);
  };

  return (
    <div ref={ref} className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex items-center gap-1 rounded-md border border-rule bg-background px-2 py-1 text-[11px] text-fg-muted hover:text-foreground transition-colors"
      >
        <Download className="h-3 w-3" aria-hidden />
        Export
        <ChevronDown className="h-3 w-3" aria-hidden />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1 z-30 min-w-[120px] rounded-md border border-rule bg-background shadow-xs py-1"
        >
          <button
            role="menuitem"
            onClick={() => trigger("csv")}
            className="block w-full px-3 py-1.5 text-left text-[11px] text-foreground hover:bg-surface"
          >Download CSV</button>
          <button
            role="menuitem"
            onClick={() => trigger("json")}
            className="block w-full px-3 py-1.5 text-left text-[11px] text-foreground hover:bg-surface"
          >Download JSON</button>
        </div>
      )}
    </div>
  );
}
