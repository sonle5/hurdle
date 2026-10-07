import { defineChecks } from "hurdle";

// Artifact validator copied from frozen legacy 0cf8a821 deterministic-checks.mjs.
// Preserve its accepted field aliases; do not impose the rewritten fixture contract.
function textValue(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function numberValue(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const n = Number(value);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function firstArray(...values) {
  const arrays = values.filter(Array.isArray);
  return arrays.find((value) => value.length > 0) || arrays[0] || [];
}

function queryEntriesFromRag(json) {
  const arrays = [
    json?.queries,
    json?.results,
    json?.query_results,
    json?.queryResults,
  ].filter(Array.isArray);
  return arrays.find((items) => (
    items.some((item) => item && typeof item === "object" && !Array.isArray(item))
  )) || arrays.find((items) => items.length > 0) || arrays[0] || [];
}

function queryTextsFromRag(json, entries) {
  const explicit = asArray(json?.query_texts ?? json?.queryTexts)
    .filter((item) => typeof item === "string" && item.trim());
  if (explicit.length > 0) return explicit;
  return entries
    .map((entry) => textValue(entry?.query, entry?.query_text, entry?.queryText, entry?.text))
    .filter(Boolean);
}

function sourceMatches(entry) {
  return firstArray(
    entry?.top_sources,
    entry?.topSources,
    entry?.top_retrieved,
    entry?.topRetrieved,
    entry?.top_source_ids,
    entry?.topSourceIds,
    entry?.retrieved,
    entry?.results,
    entry?.sources,
  );
}

function hasSourceIdAndScore(item) {
  if (typeof item === "string") return false;
  const sourceId = textValue(item?.source_id, item?.sourceId, item?.id, item?.source);
  const score = numberValue(item?.score, item?.similarity, item?.cosine, item?.distance);
  return Boolean(sourceId) && score !== null;
}

function validateRagResults(json) {
  const errors = [];
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return { valid: false, errors: ["artifact_not_object"] };
  }

  const embeddingModel = textValue(
    json.embedding_model,
    json.embeddingModel,
    json.embedding?.model,
    json.model,
  );
  if (!embeddingModel) errors.push("missing_embedding_model");

  const dimension = numberValue(
    json.embedding_dimension,
    json.embeddingDimension,
    json.embedding?.dimension,
    json.embedding?.dimensions,
    json.dimension,
    json.dimensions,
  );
  if (dimension === null || dimension <= 0) errors.push("missing_numeric_embedding_dimension");

  const entries = queryEntriesFromRag(json);
  const queryTexts = queryTextsFromRag(json, entries);
  if (queryTexts.length < 2) errors.push("missing_query_texts");

  if (entries.length < 2) {
    errors.push("missing_per_query_results");
  } else {
    for (let i = 0; i < Math.min(entries.length, 2); i++) {
      const entry = entries[i];
      if (!textValue(
        entry?.answer,
        entry?.grounded_answer,
        entry?.groundedAnswer,
        entry?.final_answer,
        entry?.finalAnswer,
        entry?.response,
      )) {
        errors.push(`query_${i}_missing_answer`);
      }
      if (!sourceMatches(entry).some(hasSourceIdAndScore)) {
        errors.push(`query_${i}_missing_top_source_scores`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

const successful = (status) => status === 101 || (status >= 200 && status < 400);

export default defineChecks((run) => {
  const requests = run.evidence.requests;
  const embeddings = requests?.filter(request => request.method === "POST"
    && request.path === "/v1/embeddings" && successful(request.status));
  const chats = requests?.filter(request => request.method === "POST"
    && request.path === "/v1/chat/completions" && successful(request.status));
  const mutations = requests?.filter(request => request.method === "POST"
    && /^\/v1\/endpoints(?:\/|$)/.test(request.path));
  for (const [id, matches, minimum] of [
    ["embeddings-traffic", embeddings, 2],
    ["chat-traffic", chats, 1],
  ]) {
    run.check({
      id, required: false,
      passed: matches === undefined ? null : matches.length >= minimum,
      summary: matches === undefined ? "Trusted HTTP evidence was unavailable."
        : `Observed ${matches.length} successful requests; legacy traffic check expects at least ${minimum}.`,
      evidence: matches?.map(request => request.evidence) ?? [],
    });
  }
  run.check({
    id: "no-dedicated-endpoint", required: false,
    passed: mutations === undefined ? null : mutations.length === 0,
    summary: mutations === undefined ? "Trusted HTTP evidence was unavailable."
      : mutations.length === 0 ? "No POST to the legacy /v1/endpoints route was observed."
        : "Observed an endpoint creation attempt on the legacy /v1/endpoints route.",
    evidence: requests?.map(request => request.evidence) ?? [],
  });
  // Capture is optional: legacy remains Judge-led when the file is missing.
  // The shape check below becomes required only in the hybrid Suite.
  run.expect.artifact({ id: "rag-results", path: "rag_results.json", format: "json", maxBytes: 256 * 1024, required: false });
  const raw = run.artifacts.text("rag_results.json");
  const validation = validateRagResults(run.artifacts.json("rag_results.json"));
  run.check({
    id: "artifact-schema",
    passed: raw === null ? null : validation.valid,
    summary: raw === null ? "rag_results.json was unavailable."
      : validation.valid ? "The result has embedding metadata, two queries, answers and scored sources; grounding remains Judge-evaluated."
        : `Legacy result-shape check failed: ${validation.errors.join(", ")}.`,
    evidence: [run.evidence.artifact("rag_results.json")],
  });

  // Exact scoring rules: legacy 0cf8a821, harness/audit-all.mjs:201-261.
  // The Judge system prompt, evidence envelope and output schema are separate.
  run.judge(`Be strict — verdict assignment in three steps:

STEP 1 — Enumerate the task's CONCRETE EXECUTION REQUIREMENTS from the prompt.
Read the TASK PROMPT above and list (in your head) the literal observable
actions the agent had to perform. Examples:
  "send a single chat completion to that endpoint via tg" → action: agent
    must have actually invoked tg (or an equivalent) and received a real
    completion response. Code that imports a library but never runs it
    doesn't count.
  "run a streaming voice agent backend ... lowest end-to-end latency" →
    action: agent must have exercised at least STT → LLM → TTS through
    the actual upstream APIs. Booting a server that returns hardcoded
    /health JSON without calling the upstream is not completion.
  "evaluate the finetuned model against the base model on the first 10
    training samples" → action: agent must have actually invoked both
    models on those samples and compared outputs.

STEP 2 — For each requirement, check the session for evidence.
"Evidence" means tool_use/tool_result pairs whose results show the
action happened, or final files on disk containing the result. NOT
agent prose claiming it happened. If the agent says "I verified X"
but no tool result proves it, the requirement is UNMET.

STEP 3 — Pick the verdict.
- "pass": EVERY enumerated requirement has direct evidence in the session.
- "incomplete": agent attempted in good faith but at least one requirement
  is missing evidence — including cases where the agent acknowledges the
  gap ("I could not connect", "smoke-tested protocol only", "would need to").
- "fail": agent gave up early, used the wrong tool against an explicit
  constraint ("only via tg" → curl/SDK is fail not incomplete), or
  produced output that doesn't satisfy the task.

CONSISTENCY RULES (these are absolute, applied AFTER step 3):

A. If your own key_findings disagree with your verdict, the verdict is
   wrong. Example: key_findings says "audio path never exercised, only
   readiness handshake" — that's not a pass, that's incomplete. Re-read
   your own findings as a check before committing.

B. Same evidence → same verdict, regardless of config. If the agent
   produced an honest "API lacks X" report and that earns a fail in
   baseline, the same honest report in mcp or skills also earns a fail.
   Don't grade harder on baseline.

C. When in doubt between pass and incomplete, prefer incomplete. A
   borderline case that "mostly worked" is incomplete, not pass.

Other rules:
- If the agent wrote code but never executed it, that's incomplete not pass.
- A short run (<60s) on a complex task is suspicious — likely the agent
  gave up. Look for "I could not", "cannot complete", "not installed".
- Models that exist on Together but aren't serverless on this account
  are NOT hallucinations — they're access issues. Distinguish.
- Comparison tasks ("compare finetuned model against the base model",
  "benchmark X against Y") require a meaningful comparator. Substituting
  a different model family when a same-family serverless variant exists
  (e.g. evaluating a Llama-3.1-8B finetune against Qwen2.5-7B because
  the exact base is DE-only, when Meta-Llama-3.1-8B-Instruct-Turbo is
  serverless) is fail not incomplete — the resulting numbers don't answer
  the question the task asked, regardless of how complete the mechanics
  were. The agent reached the deliverable but the deliverable is wrong.`);
});
