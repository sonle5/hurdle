# Together evaluations

These evaluations exercise real Together APIs with Claude Code as the Agent.
Four Tasks are included in the shipped Suites:

| Task | What it evaluates |
| --- | --- |
| `chat-app` | Chat completion, image generation and transcription. |
| `rag-search` | Embeddings, local retrieval and grounded answers. |
| `tool-calling-agent-loop` | Native Together tool calls with local mock tools. |
| `gpu-clusters` | GPU discovery and reservation-command generation. It never reserves a cluster. |

Four additional definitions are catalogue-only and cannot be selected by a
shipped Suite:

| Task | Why it is not enabled |
| --- | --- |
| `vision-bench` | Model availability and cost still need live verification. |
| `voice-agent` | Streaming behavior and process termination need more testing. |
| `batch-job` | Persistent-job cancellation and cleanup are not yet guaranteed. |
| `finetune` | Training and endpoint cleanup are not yet guaranteed. |

## Suites

| Suite | Tasks | Passing requires |
| --- | --- | --- |
| `legacy.suite.mjs` | Chat, RAG, tool calling and GPU discovery | Judge pass; code checks are advisory. |
| `hybrid.suite.mjs` | RAG and tool calling | Required result-file checks and Judge pass. |

`showcase.suite.mjs` is an alias for the legacy matrix.
`chat-app.suite.mjs` is a single baseline Judge-led run.

Both main Suites use a Sonnet 4.6 Agent, an Opus 4.8 Judge, one repeat, and the
baseline, MCP and full-skills Conditions. The full-skills Condition supplies the
complete vendored Together skills snapshot rather than a Task-specific subset.
The upstream MIT notice is retained in [skills/LICENSE](skills/LICENSE).

Mandatory Run Trust applies in both Suites. A Judge cannot turn an untrusted or
incomplete run into a pass.

## Run an evaluation

From the repository root, add the required Agent, Judge and Together credentials
to an ignored `.env.local`, then start with one paid cell:

```sh
npm run legacy -- --task rag-search --condition baseline
npm run hybrid -- --task rag-search --condition baseline
```

These commands perform separate Agent runs. They default to Local execution,
filesystem results and the same Viewer. `npm run showcase` is an alias for
legacy mode.

The selected Tasks make real API calls and may incur Agent, Judge and Together
charges. Local execution is not a security sandbox: the Agent process receives
the Together credential. E2B and Postgres are available as opt-in beta backends;
see [beta backends](../../docs/beta-backends.md).

## How checks work

The code checks capture useful objective signals such as successful Together
requests, expected result-file structure and forbidden resource-creation calls.
Local execution cannot observe HTTP traffic as trusted evidence, so traffic
checks are skipped rather than passed. E2B can provide that captured metadata.

Result-file checks validate structure, not semantic correctness or genuine API
use. The Judge still evaluates requirements such as grounding and correct tool
behavior. Hybrid mode requires both its deterministic checks and the Judge to
pass.

Task prompts and Judge rubrics are shared across the legacy and hybrid Suites,
but this framework uses a different evidence envelope and stricter Run Trust
than the previous runner. Do not combine its scores with historical production
results as a continuous trend.

See [authoring](../../docs/authoring.md) to create Tasks and Suites.
