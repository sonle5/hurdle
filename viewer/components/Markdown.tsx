import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const components: Components = {
  // Captured text must not trigger requests to Agent-chosen URLs on inspection.
  img: ({ alt }) => <span className="text-fg-muted">[Image omitted{alt ? `: ${alt}` : ""}]</span>,
  table: ({ children }) => (
    <div className="overflow-x-auto my-4 rounded-md border border-rule">
      <table className="w-full text-sm border-collapse">{children}</table>
    </div>
  ),
  thead: ({ children }) => (
    <thead className="bg-surface">{children}</thead>
  ),
  tr: ({ children }) => (
    <tr className="border-b border-rule last:border-b-0">{children}</tr>
  ),
  th: ({ children }) => (
    <th className="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-[0.08em] text-fg-muted">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="px-3 py-2 align-top text-foreground">{children}</td>
  ),
  code: ({ children, className }) => {
    const isInline = !className;
    if (isInline) {
      return (
        <code className="bg-surface border border-rule px-1 py-0.5 rounded-sm text-[12px] font-mono text-foreground">
          {children}
        </code>
      );
    }
    return (
      <code className="block bg-surface border border-rule p-3 rounded-md text-[12px] font-mono text-foreground overflow-x-auto">
        {children}
      </code>
    );
  },
  h1: ({ children }) => (
    <h1 className="text-lg font-semibold mt-4 mb-2 text-foreground">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="text-base font-semibold mt-4 mb-2 text-foreground">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-sm font-semibold mt-3 mb-2 text-foreground">{children}</h3>
  ),
  p: ({ children }) => (
    <p className="text-sm leading-7 mb-3 text-foreground/85">
      {children}
    </p>
  ),
  a: ({ children, href }) => (
    <a
      href={href}
      className="text-foreground underline underline-offset-2 hover:opacity-70 transition-opacity"
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </a>
  ),
  ul: ({ children }) => (
    <ul className="list-disc ml-5 space-y-1 mb-3 text-sm text-foreground/85">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="list-decimal ml-5 space-y-1 mb-3 text-sm text-foreground/85">
      {children}
    </ol>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold text-foreground">
      {children}
    </strong>
  ),
};

export function Markdown({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {content}
    </ReactMarkdown>
  );
}
