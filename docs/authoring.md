# Authoring evaluations

From repository root after setup, run `npm --prefix harness exec -- tae init my-evals`. There is one public authoring path:
Suite modules and Task folders. The framework derives its internal execution
data; there is no second configuration file to maintain.

```js
import { defineSuite } from "tae";

export default defineSuite({
  tasks: ["./tasks/copy-message"],
  agents: [{ runner: "claude-code", model: "claude-sonnet-4-6" }],
  conditions: { baseline: { skills: [], mcpServers: [] } },
  repeats: 2,
  verdict: "code",
});
```

Each Task has a `prompt.md` and `checks.mjs`. Files under `fixtures/` are
staged with that prefix; files under `workspace/` are staged at workspace root.
Use workspace files when a prompt names an existing exact path. Symlinks and
overlapping staged paths are rejected.

For Claude Code, a Condition with `skills: []` disables all skills, including
built-in skills, on initial and resumed turns. Conditions with selected skills
keep skills enabled and stage the selected files; Claude Code's own bundled
skills may also be available in those Conditions. MCP selection is independent.
This baseline isolation fixes older preview behavior; do not mix results from
before and after the change as evidence of score continuity.

```js
import { defineChecks } from "tae";

export default defineChecks((run) => {
  run.expect.completed();
  run.expect.artifact({
    id: "answer", path: "answer.txt", format: "text", maxBytes: 4096,
  });
  run.check({
    id: "exact-copy",
    passed: run.artifacts.text("answer.txt") === "Hello from the fixture.\n",
    summary: "The output must match the fixture exactly.",
  });
});
```

Checks execute against captured results, not a live Agent workspace. They must
be deterministic trusted repository code. No arbitrary helper imports, network
calls or credentials belong in checks. Other existing helpers include
`replyIncludes`, `request`, `tool` and advisory `run.observe.request`.
Declare bounded artifacts before reading them. Ordinary `run.check` is enough
for task-specific assertions; do not build a new assertion DSL.

## Verdicts and repeats

- `code`: required checks decide quality; no Judge.
- `judge`: `run.judge(rubric)` supplies the rubric; code checks are advisory.
- `hybrid`: required code checks must pass **and** the Judge must return pass.
  Missing required code evidence or an unavailable Judge means incomplete;
  a required code failure stays fail even if the Judge passes. HTTP observations
  authored as advisory remain advisory. With no required code checks, the result
  is unknown, not a Judge-only pass.

New hybrid Suites snapshot internal authority policy version 2. Older version-1
snapshots retain their original code-pass fallback when a Judge is unavailable;
stored results are not rewritten or rescored. Judge mode and code mode keep their
existing policy. Treat new hybrid results as a separate comparison cohort.

For judged modes, add `judge: { model: "claude-opus-4-8" }` to the Suite
and configure the matching Judge credential/backend in a Runtime file.
Do not confuse a missing Judge configuration (rejected before execution) with
a configured provider failing during a Run.

The Judge receives a bounded, redacted transcript. New Suites split long JSONL
transcripts at message boundaries into ordered chunks, using the existing total
evidence budget. Oversized individual messages may have long payloads shortened
with explicit markers; message IDs, ordering and short tool results are retained.
If the complete structure cannot fit, judging reports input unavailable rather
than silently dropping messages. Existing verdict rules still apply to that
Judge failure. This internal projection is versioned in the Run snapshot; use a
new experiment label after this change. Old results are not rewritten or rescored.

Run Trust is mandatory in every mode: execution, capture, cleanup or disposal
problems cannot become a pass because the Judge liked the answer. Pass, fail,
incomplete and unknown stay distinct; unknown is not a scored failure.
Repeats are independent: two repeats run twice even if the first fails.

`--task`, `--condition`, `--agent` and `--model` only narrow selections
already present in the Suite. Change the Suite to change models or repeats.
The selected and Agent-reported model identifiers are stored with the Run;
snapshots preserve prompts, fixtures, checks and Condition resources.
Native Local runs record the actual Claude Code/Codex runner, Node, Python and
pip versions observed before Agent execution, when those tools respond. Probes
are bounded, use no API credentials, and stay outside the scored transcript and
Judge input. Values live in `metrics.adapters[adapterId].toolVersions`; the
Viewer shows them in run details. Unavailable versions stay null, never inferred
from requested models or the machine viewing the results. Remote E2B versions,
MCP-server versions and arbitrary libraries installed during a Task are not
captured by this Local observation. Matching labels alone do not establish
reproducibility; the Viewer excludes mismatched or unavailable snapshot identities
from scored comparisons.
Runner-version differences also split comparison cohorts. Node/Python/pip values
are visibility metadata: inspect them before comparing results; those differences
are not automatically excluded by Compare.

Local sets `PIP_REQUIRE_VIRTUALENV=true` so ordinary `pip`, `pip3` and
`python -m pip install` cannot install into the host Python. Create and use a
venv inside the temporary workspace. This is an accidental-host-write guard,
not containment against explicit overrides, absolute host paths or other tools.
`HOME` and `PIP_REQUIRE_VIRTUALENV` are framework-owned Local environment names,
not Target credential names. Existing pip configuration is otherwise preserved.

## Label runs for comparison

By default, the Viewer groups unlabeled runs under **Unversioned runs**.
Use an experiment label to keep separate runs or batches easy to select:

```sh
npm --prefix harness exec -- tae run my-evals/example.suite.mjs --experiment-version before
npm --prefix harness exec -- tae run my-evals/example.suite.mjs --experiment-version after
```

Each command runs the Suite and may incur Agent/API costs. In **Compare**, select
the two labels. A label names a cohort, not a claim of score continuity:
mismatched or missing captured definition identities are excluded from scored
comparison even if the task names match.

## API credentials and evidence

A Suite may name `api: { authorizationCredential: "YOUR_API_KEY",
hosts: ["api.example.com"] }`. This exposes that named credential to its Tasks
for Local execution, including Judge-only Tasks. Supply values at runtime;
never commit them. The CLI warns before execution.

Before persistence and Judge delivery, the framework redacts known credentials
and their printed leading fragments of at least eight characters, including in
transcripts, stderr and captured artifacts. It does not guarantee removal of
arbitrary encodings, shorter fragments or unrelated sensitive data. Avoid asking
Agents to print keys and review artifacts before sharing them. This protection
applies to newly captured evidence; it does not rewrite existing Result Stores.
Text that coincidentally matches a known credential prefix is also redacted.

Native Local cannot prove intercepted HTTP/tool evidence. Required request/tool
checks reject an unsupported runtime before allocation. Advisory observations
report unavailable rather than inventing evidence. Use the beta E2B Runtime for
trusted interception and inspect its recorded Run Trust.

An evidence SHA identifies captured, content-addressed bytes; it is not the
evidence itself and does not prove that a check passed. The Viewer projects
the stored outcome, transcript and check source without rescoring.
