// Standard, short-context GPT-6.1 Sol rates, verified 2026-10-12:
// https://developers.openai.com/api/docs/models/gpt-6.1-sol
// These are display estimates, never provider invoices or stored Run metrics.
const SOL_RATES = Object.freeze({ input: 2, cachedInput: 0.1, output: 10 });
const count = value => Number.isSafeInteger(value) && value >= 0;
const money = value => Number.isFinite(value) && value >= 0;

export function projectRunCost(record) {
  const unavailable = { costUsd: null, costSource: "unavailable" };
  if (record.state !== "complete") return unavailable;
  const common = record.metrics?.common ?? {};
  // A provider-reported zero is authoritative too.
  const reported = money(common.reportedCostUsd) ? common.reportedCostUsd : common.costUsd;
  if (money(reported)) return { costUsd: reported, costSource: "reported" };
  const model = record.execution?.observedModel ?? record.snapshot?.agent?.requestedModel;
  if (record.snapshot?.agent?.adapterId !== "codex" || model !== "gpt-6.1-sol") return unavailable;
  const input = common.inputTokens;
  const cached = record.metrics?.adapters?.codex?.cachedInputTokens;
  const output = common.outputTokens;
  // Missing cache counts cannot safely be interpreted as uncached input.
  // Aggregate totals above the context threshold do not identify per-call tiers.
  if (![input, cached, output].every(count) || cached > input || input > 272_000) return unavailable;
  // Cached input is a subset of input; reasoning is already in outputTokens.
  const costUsd = ((input - cached) * SOL_RATES.input + cached * SOL_RATES.cachedInput + output * SOL_RATES.output) / 1_000_000;
  return { costUsd, costSource: "estimated" };
}

export function formatRunCost(value, source) {
  if (!money(value)) return "—";
  const text = value > 0 && value < 0.01 ? "<$0.01" : `$${value.toFixed(2)}`;
  return source === "estimated" ? `≈${text}` : text;
}

export function runCostDescription(source) {
  if (source === "estimated") return "Estimated agent model cost at standard short-context rates. Assumes no separately billed cache writes; excludes tier/region adjustments, sandbox and task API charges. Provider billing may differ.";
  return source === "reported" ? "Agent model cost reported by the runner; excludes sandbox and task API charges." : "Agent model cost is unavailable.";
}
