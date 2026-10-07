import { codeToHtml } from "shiki/bundle/web";

/** @param {readonly { path: string, entry: boolean }[]} sources */
export function checkSourcePath(sources) {
  const entry = sources.find(source => source.entry)?.path ?? sources[0]?.path ?? "";
  // V1 captures the authored checks beside its generated evaluator entry point.
  const checks = entry.replace(/\.mjs$/, "-checks.mjs");
  return sources.some(source => source.path === checks) ? checks : entry;
}

/** @param {string} path */
function sourceLanguage(path) {
  const extension = path.split(".").at(-1)?.toLowerCase();
  if (["js", "mjs", "cjs"].includes(extension ?? "")) return "javascript";
  if (["ts", "mts", "cts"].includes(extension ?? "")) return "typescript";
  if (extension === "tsx") return "tsx";
  if (extension === "json") return "json";
  if (extension === "py") return "python";
  if (["sh", "bash", "zsh"].includes(extension ?? "")) return "shellscript";
  if (["yaml", "yml"].includes(extension ?? "")) return "yaml";
  if (extension === "md") return "markdown";
  return "text";
}

/** @param {string} source @param {string} path */
export function highlightCheckSource(source, path) {
  return codeToHtml(source, {
    lang: sourceLanguage(path),
    themes: { light: "github-light", dark: "github-dark" },
    defaultColor: false,
    transformers: [{
      name: "hurdle-check-lines",
      line(node, line) {
        node.properties["data-line"] = line;
      },
      code(node) {
        // Block rows already supply line breaks. Remove Shiki's separators only;
        // leave each line's tokens, indentation and intentional blank rows intact.
        node.children = node.children.filter(child => child.type !== "text" || child.value !== "\n");
      },
    }],
  });
}
