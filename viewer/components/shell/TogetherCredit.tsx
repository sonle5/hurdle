import { cn } from "@/lib/utils";

/**
 * Built-by Together AI credit.
 *
 * Keep Together's three-color mark intact in every theme. Only the wordmark
 * changes for contrast: charcoal in light mode and white in dark mode.
 */
export function TogetherCredit({ className }: { className?: string }) {
  return (
    <a
      href="https://www.together.ai"
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Built by Together AI"
      className={cn(
        "inline-flex items-center gap-2 text-[11px] text-fg-faint hover:text-foreground transition-colors group",
        className,
      )}
    >
      <span>Built by</span>
      <img
        src="/together-logo-light.png"
        alt="together.ai"
        className="h-4 w-auto opacity-90 transition-opacity group-hover:opacity-100 dark:hidden"
      />
      <img
        src="/together-logo.png"
        alt=""
        aria-hidden="true"
        className="hidden h-4 w-auto opacity-90 transition-opacity group-hover:opacity-100 dark:block"
      />
    </a>
  );
}
