import { CodeBlock } from "@/components/CodeBlock";
import { CopyButton } from "@/components/ui/CopyButton";

const FIRST_RUN_STEPS = [
  { title: "Create an evaluation", command: "npx hurdle init" },
  { title: "Set up your sandbox", command: "npx hurdle setup" },
  { title: "Run and view results", command: "npx hurdle run --view" },
];

export function GettingStarted({ steps = FIRST_RUN_STEPS, needsRunOptions = false }: {
  steps?: readonly { title: string; command: string }[];
  needsRunOptions?: boolean;
}) {
  const step = needsRunOptions
    ? { title: "Choose your run options", command: "npx hurdle run --help" }
    : steps[0] ?? FIRST_RUN_STEPS[0];
  const opensResults = /\s--view(?:\s|$)/.test(step.command);
  return (
    <div className="mx-auto max-w-xl py-8 sm:py-12">
      <div className="mb-7 text-center">
        <h1 className="text-balance text-2xl font-semibold tracking-tight sm:text-3xl">
          Run your first evaluation
        </h1>
        <p className="mt-3 text-sm text-fg-muted">
          Run this command in your project terminal.
        </p>
      </div>
      <div className="overflow-hidden rounded-lg border border-rule bg-background px-4 py-4 shadow-xs sm:px-5">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium">{step.title}</h2>
          <CopyButton value={step.command} label="Copy" ariaLabel={`Copy ${step.title.toLowerCase()} command`} size="xs" />
        </div>
        <CodeBlock code={step.command} lang="shellscript" className="p-0 text-[13px] leading-7 [&_pre]:!bg-transparent [&_pre]:!p-0 [&_pre]:!leading-7" />
      </div>
      <p className="mt-5 text-center text-xs text-fg-muted">
        {opensResults ? "Your results will open automatically." : "Follow the next steps in your terminal."}
      </p>
    </div>
  );
}
