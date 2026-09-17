# Together evaluations

Start with one paid RAG cell:

```sh
npm run preflight
npm run hybrid -- --task rag-search --condition baseline
```

The run uses Claude Code with Sonnet 4.6, scores with deterministic checks and
an Opus 4.8 Judge, saves results to the filesystem, and opens the Viewer.

## Included tasks

| Task | What it evaluates |
| --- | --- |
| `chat-app` | Chat completion, image generation, and transcription |
| `rag-search` | Embeddings, local retrieval, and grounded answers |
| `tool-calling-agent-loop` | Native Together tool calls with local mock tools |
| `gpu-clusters` | GPU discovery and reservation-command generation; it never reserves a cluster |

The legacy and hybrid Suites compare a no-skills baseline with MCP and the full
vendored Together skills directory.

## Choose a Suite

| Command | Runs | Passing requires |
| --- | ---: | --- |
| `npm run chat-app` | 1 | Judge pass |
| `npm run hybrid` | 6 | Required code checks and Judge pass |
| `npm run legacy` | 12 | Judge pass; code checks are advisory |

`npm run showcase` is an alias for `npm run legacy`.

Use `--task` and `--condition` to run a smaller selection:

```sh
npm run legacy -- --task gpu-clusters --condition baseline
npm run hybrid -- --task tool-calling-agent-loop --condition skills
```

Every selected cell starts a separate Agent run. Agent, Judge, and Together API
usage may be billed.

Add `ANTHROPIC_API_KEY` and `TOGETHER_API_KEY` to the ignored `.env.local`
file before running. Local execution gives the Agent the Together credential and
is not a security sandbox.

## How scoring works

The code checks inspect objective evidence such as:

- successful Together requests;
- expected result-file structure;
- forbidden resource-creation calls.

Local execution cannot capture HTTP traffic as trusted evidence, so traffic
checks are skipped rather than passed. E2B can capture the required metadata.

Result-file checks prove structure, not semantic correctness or genuine API use.
The Judge evaluates grounding, tool behavior, and other semantic requirements.
Mandatory Run Trust prevents an execution or evidence-capture problem from
becoming a pass.

The legacy and hybrid Suites share their task prompts and Judge rubrics.
However, this framework uses a different evidence envelope and stricter Run
Trust than the previous production runner. Do not combine these results with the
historical score series.

## Optional backends

Local execution and filesystem storage are the defaults. E2B and Postgres are
opt-in beta backends. Follow the [backend setup guide](../../docs/beta-backends.md).

## Catalogue-only tasks

These definitions are included for continued development but cannot be selected
by a shipped Suite:

| Task | Why it is disabled |
| --- | --- |
| `vision-bench` | Model availability and cost need live verification |
| `voice-agent` | Streaming and process termination need more testing |
| `batch-job` | Persistent-job cancellation and cleanup are not guaranteed |
| `finetune` | Training and endpoint cleanup are not guaranteed |

See the [authoring guide](../../docs/authoring.md) to create Tasks and Suites.
