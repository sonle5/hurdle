import { spawn, execSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { homedir, platform } from "os";

export function hasAnthropicApiKey(env = process.env) {
  return !!env.ANTHROPIC_API_KEY?.trim();
}

export function prepareClaudeEnv(env = process.env) {
  const out = { ...env };
  if (hasAnthropicApiKey(out)) {
    // When both auth signals are present, make the API key the unambiguous choice.
    delete out.CLAUDE_CODE_OAUTH_TOKEN;
  } else {
    delete out.ANTHROPIC_API_KEY;
  }
  return out;
}

export function detectClaudeAuthMode(env = process.env) {
  if (hasAnthropicApiKey(env)) return "apikey";
  if (env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) return "oauth";
  if (platform() === "darwin") {
    try {
      execSync("security find-generic-password -s 'Claude Code-credentials'", { stdio: "ignore" });
      return "oauth";
    } catch { /* fall through */ }
  } else if (existsSync(join(homedir(), ".claude", ".credentials.json"))) {
    return "oauth";
  }
  return "none";
}

export function buildClaudePrintArgs({
  model = null,
  systemPrompt = null,
  disableTools = false,
  bare = false,
} = {}) {
  return [
    ...(bare ? ["--bare"] : []),
    "-p",
    ...(model ? ["--model", model] : []),
    ...(systemPrompt ? ["--system-prompt", systemPrompt] : []),
    ...(disableTools ? ["--tools", ""] : []),
    "--output-format",
    "json",
    ...(!disableTools ? ["--dangerously-skip-permissions"] : []),
  ];
}

/**
 * Run `claude -p` in print mode with the prompt on STDIN (never argv).
 *
 * The prompt embeds the (large) session transcript, and Linux caps a single
 * argv string at 128KB (MAX_ARG_STRLEN) — passing it as `-p <prompt>` throws
 * E2BIG on the CI runner (macOS has no per-arg cap, so it only ever surfaced in
 * Linux CI). `claude -p` reads the prompt from stdin when given no query arg.
 *
 * Centralized here so this fix lives in ONE place — it was previously hand-copied
 * into audit-all.mjs, audit-codex.mjs, and suggest-shared.mjs and had to be kept
 * in sync by hand. Returns raw stdout plus process status; callers parse the result.
 *
 * @param {{
 *   prompt: string,
 *   model?: string|null,
 *   env?: NodeJS.ProcessEnv,
 *   timeoutMs?: number,
 *   systemPrompt?: string|null,
 *   disableTools?: boolean,
 * }} opts
 * @returns {Promise<{ stdout: string, code: number|null, signal: string|null, timedOut: boolean, error: string|null }>}
 */
export function runClaudePrint({
  prompt,
  model = null,
  env = process.env,
  timeoutMs = 120_000,
  systemPrompt = null,
  disableTools = false,
}) {
  return new Promise((resolve) => {
    const preparedEnv = prepareClaudeEnv(env);
    const args = buildClaudePrintArgs({
      model,
      systemPrompt,
      disableTools,
      bare: hasAnthropicApiKey(preparedEnv),
    });
    const child = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"], env: preparedEnv });
    let timedOut = false;
    child.stdin.on("error", () => {}); // ignore EPIPE if claude exits before the write finishes
    child.stdin.end(prompt);

    const chunks = [];
    child.stdout.on("data", (d) => chunks.push(d));
    child.stderr.on("data", () => {});
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(chunks).toString(), code, signal, timedOut, error: null });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(chunks).toString(), code: -1, signal: null, timedOut, error: error.message });
    });
  });
}

/**
 * Extract the verdict JSON embedded in `claude -p --output-format json` stdout.
 * Claude wraps the agent's response in `{ result: "...text..." }`, and the audit
 * prompt asks for a JSON verdict object inside that text. Returns the parsed
 * object or null. Shared by audit-all.mjs and audit-codex.mjs.
 *
 * @param {string} stdout
 * @returns {object|null}
 */
export function parseAuditVerdict(stdout) {
  try {
    const cc = JSON.parse(stdout);
    const resultText = cc.result || "";
    const a = resultText.indexOf("{");
    const b = resultText.lastIndexOf("}") + 1;
    if (a >= 0 && b > a) return JSON.parse(resultText.slice(a, b));
  } catch { /* fall through to null */ }
  return null;
}
