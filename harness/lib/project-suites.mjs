import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";

const SKIP_DIRECTORIES = new Set([
  "node_modules", "vendor", "dist", "build", "coverage", "viewer-runtime",
]);

// Discover filenames only. Listing/help must never import or evaluate Suite code.
export function discoverProjectSuites(cwd) {
  const paths = [];
  let visited = 0;
  function walk(directory, depth) {
    if (depth > 12) throw new Error("Suite discovery reached its directory depth limit. Use an explicit .suite.mjs path.");
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); }
    catch (error) {
      // Unreadable directories, such as container volumes, cannot hold Suites.
      if (depth > 0 && ["EACCES", "EPERM"].includes(error?.code)) return;
      throw error;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (++visited > 50_000) throw new Error("Suite discovery reached its file limit. Use an explicit .suite.mjs path.");
      if (entry.name.startsWith(".") || /[\x00-\x1f\x7f]/.test(entry.name)) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory() && !SKIP_DIRECTORIES.has(entry.name)) walk(path, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".suite.mjs")) {
        const selected = relative(cwd, path).split(sep).join("/");
        paths.push(selected.startsWith("-") ? `./${selected}` : selected);
      }
    }
  }
  walk(resolve(cwd), 0);
  const suites = paths.map(path => ({
    path,
    name: basename(path) === "example.suite.mjs"
      ? dirname(path) === "." ? "example" : basename(dirname(path))
      : basename(path, ".suite.mjs"),
    bundled: path.startsWith("examples/"),
  }));
  const counts = new Map();
  for (const suite of suites) counts.set(suite.name, (counts.get(suite.name) ?? 0) + 1);
  return suites.map(suite => ({ ...suite, ambiguous: counts.get(suite.name) > 1 }));
}

export function defaultProjectSuite(cwd, suites) {
  for (const path of ["evals/example.suite.mjs", "example.suite.mjs"]) {
    if (existsSync(resolve(cwd, path))) return path;
  }
  const authored = (suites ?? discoverProjectSuites(cwd)).filter(suite => !suite.bundled);
  return authored.length === 1 ? authored[0].path : "example.suite.mjs";
}

export function resolveProjectSuite(cwd, selection) {
  // Explicit paths keep working outside discovery roots, including symlinks;
  // the existing Suite loader remains responsible for validating those paths.
  if (selection.endsWith(".suite.mjs")) return { path: selection };
  const matches = discoverProjectSuites(cwd).filter(suite => suite.name === selection);
  if (matches.length === 1) return { path: matches[0].path };
  return { path: null, matches };
}
