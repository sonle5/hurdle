import { defineChecks } from "hurdle";

// Artifact validator copied from frozen legacy 0cf8a821 deterministic-checks.mjs.
// Shape is not proof that the provider returned these calls or that local tools ran.
function textValue(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function firstArray(...values) {
  const arrays = values.filter(Array.isArray);
  return arrays.find((value) => value.length > 0) || arrays[0] || [];
}

function toolCallsFromArtifact(json) {
  return firstArray(json?.tool_calls, json?.toolCalls);
}

function parseableArguments(call) {
  const args = (
    call?.arguments
    ?? call?.args
    ?? call?.input
    ?? call?.function?.arguments
    ?? call?.raw_arguments
    ?? call?.rawArguments
    ?? call?.parsed_arguments
    ?? call?.parsedArguments
  );
  if (args && typeof args === "object") return true;
  if (typeof args !== "string" || !args.trim()) return false;
  try {
    JSON.parse(args);
    return true;
  } catch {
    return false;
  }
}

function localToolResults(json) {
  return firstArray(
    json?.local_tool_results,
    json?.localToolResults,
    json?.tool_results,
    json?.toolResults,
    json?.results,
  );
}

function validateToolCallingResults(json) {
  const errors = [];
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return { valid: false, errors: ["artifact_not_object"] };
  }

  if (!textValue(json.model)) errors.push("missing_model");

  const calls = toolCallsFromArtifact(json);
  if (calls.length < 2) {
    errors.push("missing_tool_calls");
  } else if (!calls.slice(0, 2).every(parseableArguments)) {
    errors.push("unparseable_tool_call_arguments");
  }

  if (localToolResults(json).length < 2) errors.push("missing_local_tool_results");
  if (!textValue(json.final_answer, json.finalAnswer, json.answer)) errors.push("missing_final_answer");
  const finishReasons = firstArray(json.finish_reasons, json.finishReasons)
    .map((value) => (
      typeof value === "string"
        ? value
        : textValue(value?.finish_reason, value?.finishReason, value?.reason)
    ))
    .filter((value) => typeof value === "string" && value.trim());
  if (finishReasons.length === 0 && !textValue(json.finish_reason, json.finishReason)) {
    errors.push("missing_finish_reasons");
  }

  return { valid: errors.length === 0, errors };
}

const successful = (status) => status === 101 || (status >= 200 && status < 400);

export default defineChecks((run) => {
  const requests = run.evidence.requests;
  const chats = requests?.filter(request => request.method === "POST"
    && request.path === "/v1/chat/completions" && successful(request.status));
  run.check({
    id: "chat-traffic-two-turns", required: false,
    passed: chats === undefined ? null : chats.length >= 2,
    summary: chats === undefined ? "Trusted HTTP evidence was unavailable."
      : `Observed ${chats.length} successful chat requests; the legacy traffic check expects at least two (not proof of tool correlation).`,
    evidence: chats?.map(request => request.evidence) ?? [],
  });
  run.expect.artifact({ id: "tool-loop-results", path: "tool_calling_agent_results.json", format: "json", maxBytes: 256 * 1024, required: false });
  const raw = run.artifacts.text("tool_calling_agent_results.json");
  const validation = validateToolCallingResults(run.artifacts.json("tool_calling_agent_results.json"));
  run.check({
    id: "artifact-schema",
    passed: raw === null ? null : validation.valid,
    summary: raw === null ? "tool_calling_agent_results.json was unavailable."
      : validation.valid ? "The result has model, parseable calls, local results, answer and finish reasons; execution remains Judge-evaluated."
        : `Legacy result-shape check failed: ${validation.errors.join(", ")}.`,
    evidence: [run.evidence.artifact("tool_calling_agent_results.json")],
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
