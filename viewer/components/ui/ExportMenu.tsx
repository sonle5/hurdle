"use client";

import { Menu } from "@base-ui/react/menu";
import { ChevronDown, Download } from "lucide-react";
import { cn } from "@/lib/utils";

export type ExportFormat = "csv" | "json";

const ITEM =
  "flex w-full cursor-default select-none rounded-md px-3 py-1.5 text-left text-[12px] text-foreground outline-none data-[highlighted]:bg-surface";

export function ExportMenu({
  filenameBase,
  onExport,
  className,
}: {
  filenameBase: string;
  onExport: (fmt: ExportFormat) => { mime: string; content: string };
  className?: string;
}) {
  const download = (fmt: ExportFormat) => {
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
  };

  return (
    <Menu.Root>
      <Menu.Trigger
        className={cn(
          "inline-flex h-7 items-center gap-1 rounded-md border border-rule bg-background px-2 text-[12px] text-fg-muted transition-colors hover:text-foreground data-[popup-open]:text-foreground",
          className,
        )}
      >
        <Download className="h-3 w-3" aria-hidden />
        Export
        <ChevronDown className="h-3 w-3" aria-hidden />
      </Menu.Trigger>
      {/* Portalled, so a short card's overflow can't clip it; it flips above
          the button when there's no room below. */}
      <Menu.Portal>
        <Menu.Positioner sideOffset={4} align="end" className="z-50 outline-none">
          <Menu.Popup className="min-w-[132px] rounded-xl border border-rule bg-background shadow-xs p-1 outline-none">
            <Menu.Item className={ITEM} onClick={() => download("csv")}>Download CSV</Menu.Item>
            <Menu.Item className={ITEM} onClick={() => download("json")}>Download JSON</Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
