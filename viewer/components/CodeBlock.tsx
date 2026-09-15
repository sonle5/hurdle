"use client";

import { useEffect, useState } from "react";
import { codeToHtml } from "shiki/bundle/web";

function isDarkActive(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.classList.contains("dark");
}

export function CodeBlock({
  code,
  lang = "json",
}: {
  code: string;
  lang?: string;
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
      <pre className="text-xs text-fg-muted overflow-x-auto bg-surface p-2 rounded whitespace-pre-wrap">{code}</pre>
    );
  }

  return (
    <div
      className="text-xs overflow-x-auto rounded [&_pre]:p-2 [&_pre]:bg-surface [&_pre]:rounded [&_pre]:whitespace-pre-wrap [&_code]:whitespace-pre-wrap"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
