"use client";

import { useEffect, useState } from "react";
import { codeToHtml } from "shiki/bundle/web";
import { cn } from "@/lib/utils";

function isDarkActive(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.classList.contains("dark");
}

export function CodeBlock({
  code,
  lang = "json",
  className,
}: {
  code: string;
  lang?: string;
  className?: string;
}) {
  const [html, setHtml] = useState<string | null>(null);
  const [dark, setDark] = useState<boolean>(isDarkActive);

  // Re-render highlighting when the theme flips.
  useEffect(() => {
    const root = document.documentElement;
    const obs = new MutationObserver(() => setDark(root.classList.contains("dark")));
    obs.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    codeToHtml(code, {
      lang,
      theme: dark ? "github-dark" : "github-light",
    }).then(setHtml);
  }, [code, lang, dark]);

  if (!html) {
    return (
      <pre className={cn("text-xs text-fg-muted overflow-x-auto bg-surface p-2 rounded-md whitespace-pre-wrap", className)}>{code}</pre>
    );
  }

  return (
    <div
      className={cn("text-xs overflow-x-auto rounded-md [&_pre]:p-2 [&_pre]:bg-surface [&_pre]:rounded-md [&_pre]:whitespace-pre-wrap [&_code]:whitespace-pre-wrap", className)}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
