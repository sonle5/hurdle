"use client";

import { Search, X } from "lucide-react";

export const MATRIX_SEARCH_INPUT_ID = "matrix-search-input";

export function MatrixSearch({
  value,
  onChange,
  placeholder = "Filter tasks…  (/)",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="relative">
      <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-fg-faint" aria-hidden />
      <input
        id={MATRIX_SEARCH_INPUT_ID}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-7 w-52 rounded-md border border-rule bg-background pl-7 pr-7 text-[12px] text-foreground placeholder:text-fg-faint focus:outline-none focus:border-foreground/40"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Clear filter"
          className="absolute right-1 top-1/2 -translate-y-1/2 inline-flex h-4 w-4 items-center justify-center rounded-sm text-fg-faint hover:text-foreground hover:bg-foreground/5"
        >
          <X className="h-3 w-3" aria-hidden />
        </button>
      )}
    </div>
  );
}
