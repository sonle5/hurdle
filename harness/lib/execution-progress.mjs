import { stripVTControlCharacters } from "node:util";

const VERDICTS = new Set(["pass", "fail", "incomplete", "unknown"]);
const RESOURCE_ROLES = new Set(["guardian", "agent"]);

// Presentation only: callers supply already-redacted stored verdict reasons,
// never provider exceptions, stderr or credentials. Keep terminal output small.
export function projectVerdictReasons(value) {
  const reasons = [];
  const seen = new Set();
  for (const reason of Array.isArray(value) ? value.slice(0, 100) : []) {
    if (!reason || typeof reason.code !== "string" || !/^[a-z][a-z0-9._-]{0,127}$/.test(reason.code)
      || typeof reason.summary !== "string") continue;
    let summary = stripVTControlCharacters(reason.summary.slice(0, 16 * 1024))
      .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
      .replace(/\s+/g, " ").trim();
    if (!summary) continue;
    if (summary.length > 300) summary = `${summary.slice(0, 299)}…`;
    const key = `${reason.code}:${summary}`;
    if (seen.has(key)) continue;
    seen.add(key);
    reasons.push(Object.freeze({ code: reason.code, summary }));
    if (reasons.length === 3) break;
  }
  return Object.freeze(reasons);
}

function boundedText(value, maximum = 256) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function projectCell(value) {
  if (
    !value
    || typeof value !== "object"
    || !positiveInteger(value.ordinal)
    || !positiveInteger(value.total)
    || value.ordinal > value.total
    || !boundedText(value.taskId)
    || !boundedText(value.conditionId)
    || !boundedText(value.adapterId)
    || !positiveInteger(value.repeatOrdinal)
    || !positiveInteger(value.repeatTotal)
    || value.repeatOrdinal > value.repeatTotal
  ) return null;
  return Object.freeze({
    ordinal: value.ordinal,
    total: value.total,
    taskId: value.taskId,
    conditionId: value.conditionId,
    adapterId: value.adapterId,
    repeatOrdinal: value.repeatOrdinal,
    repeatTotal: value.repeatTotal,
  });
}

function projectEvent(value) {
  if (!value || typeof value !== "object") return null;
  if (value.kind === "matrix-ready" && positiveInteger(value.total)) {
    return Object.freeze({ kind: value.kind, total: value.total });
  }
  if (value.kind === "cell-started") {
    const cell = projectCell(value.cell);
    return cell ? Object.freeze({ kind: value.kind, cell }) : null;
  }
  if (value.kind === "environment-resource-allocated") {
    const resource = value.resource;
    if (
      value.environmentId !== "e2b"
      || !boundedText(value.executionId)
      || !resource
      || typeof resource !== "object"
      || resource.provider !== "e2b"
      || !RESOURCE_ROLES.has(resource.role)
      || !boundedText(resource.id)
    ) return null;
    return Object.freeze({
      kind: value.kind,
      executionId: value.executionId,
      environmentId: "e2b",
      resource: Object.freeze({
        provider: "e2b",
        role: resource.role,
        id: resource.id,
      }),
    });
  }
  if (value.kind === "cell-completed") {
    const cell = projectCell(value.cell);
    const terminal = value.terminal;
    if (
      !cell
      || !terminal
      || typeof terminal !== "object"
      || !boundedText(terminal.id)
      || !VERDICTS.has(terminal.verdict)
    ) return null;
    const runTrustReasons = terminal.verdict === "pass"
      ? Object.freeze([])
      : projectVerdictReasons(terminal.runTrustReasons);
    return Object.freeze({
      kind: value.kind,
      cell,
      terminal: Object.freeze({
        id: terminal.id, verdict: terminal.verdict,
        verdictReasons: terminal.verdict === "pass" ? Object.freeze([]) : projectVerdictReasons(terminal.verdictReasons),
        ...(runTrustReasons.length > 0 ? { runTrustReasons } : {}),
      }),
    });
  }
  return null;
}

export function normalizeExecutionProgressObserver(observer = null) {
  if (observer === null || observer === undefined) return null;
  if (
    typeof observer !== "object"
    || Array.isArray(observer)
    || typeof observer.observe !== "function"
  ) {
    throw new TypeError("Execution progress observer must expose observe(event)");
  }
  return Object.freeze({ observe: observer.observe.bind(observer) });
}

export function reportExecutionProgress(observer, candidateEvent) {
  if (!observer) return false;
  const event = projectEvent(candidateEvent);
  if (!event) return false;
  try {
    const result = observer.observe(event);
    if (result && typeof result.then === "function") {
      Promise.resolve(result).catch(() => {});
    }
  } catch {}
  return true;
}
