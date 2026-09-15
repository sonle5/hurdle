import { defineChecks } from "tae";

// Discovery-only legacy checks, not the later cluster-creation lifecycle task.
const successful = (status) => status === 101 || (status >= 200 && status < 400);

export default defineChecks((run) => {
  const requests = run.evidence.requests;
  const regions = requests?.filter(request => request.method === "GET"
    && /^\/(?:v1\/)?compute\/regions(?:\/|$)/.test(request.path)
    && successful(request.status));
  const reservations = requests?.filter(request => request.method === "POST"
    && /^\/(?:v1\/)?(?:compute|clusters|gpu)(?:\/|$)/.test(request.path));
  run.check({
    id: "region-inventory", required: false,
    passed: regions === undefined ? null : regions.length > 0,
    summary: regions === undefined ? "Trusted HTTP evidence was unavailable."
      : regions.length > 0 ? "Observed a successful GPU region inventory request."
        : "No successful GPU region inventory request was observed.",
    evidence: regions?.map(request => request.evidence) ?? [],
  });
  run.check({
    id: "no-reservation", required: false,
    passed: reservations === undefined ? null : reservations.length === 0,
    summary: reservations === undefined ? "Trusted HTTP evidence was unavailable; no-reservation was not verified."
      : reservations.length === 0 ? "No POST to legacy compute, clusters or GPU routes was observed; this is not a cleanup guarantee."
        : "Observed a GPU reservation or cluster creation attempt.",
    evidence: requests?.map(request => request.evidence) ?? [],
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
