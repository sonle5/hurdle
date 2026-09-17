![tae · together agent evals. Tasks run through coding agents and produce evidence for evaluation.](docs/assets/readme-hero.png)

# Together Agent Evals

Test how Claude Code and Codex use an API, SDK, or documentation. Define a task,
select a model and conditions, then score each run with code checks, a Judge, or
both.

Each run saves its prompt, transcript, tool calls, checks, and verdict to disk.
The read-only Viewer opens those results for inspection and comparison.

These scores are not a continuation of the legacy trend series.

## Quick start

Install Node.js 22.13 or newer and the Claude Code CLI. Set either
`ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`, then run this command from the
repository root:

```sh
npm run quickstart
```

The command installs dependencies, runs one copy-message task, and opens the
Viewer. Your agent provider may charge for the run. You do not need a Together
key, a Judge, an E2B account, or a database. The task creates no Together
resources.

Results are saved in `.tae/results-v1`. Reopen them with `npm run view`.
To install without running an evaluation, use `npm run setup`.

> [!WARNING]
> Local runs execute agent code on your computer with network access. Local
> execution is not a security sandbox. Only run tasks, checks, and suites you
> trust.

The local runtime uses a temporary home directory and requires a Python virtual
environment for ordinary pip installs. These safeguards reduce accidental host
writes, but they do not contain agent code. Read
[local execution and credentials](docs/authoring.md#credentials-and-safety).

## Write your own evaluations

A task directory contains `prompt.md`, `checks.mjs`, and any input files. A suite
selects tasks, agents, models, conditions, and repeat counts. Its `verdict`
setting controls scoring:

- `code` requires deterministic checks to pass.
- `judge` uses the rubric in each task.
- `hybrid` requires both the code checks and the Judge to pass.

After running `npm run setup`, create and run an evaluation:

```sh
npm --prefix harness exec -- tae init my-evals
npm --prefix harness exec -- tae validate my-evals/example.suite.mjs
npm --prefix harness exec -- tae run my-evals/example.suite.mjs --view
```

Read the [authoring guide](docs/authoring.md) and the
[copy-message example](examples/copy-message/example.suite.mjs) for the file
format and check API.

## Try the Together tasks

The repository includes Together tasks for chat, RAG search, tool calling, and
GPU discovery without reservation. The suites compare a baseline agent with MCP
and the full Together skills directory.

Add `TOGETHER_API_KEY` and `ANTHROPIC_API_KEY` to the ignored `.env.local` file.
Check configured credentials before starting a longer evaluation:

```sh
npm run preflight
```

This makes minimal Anthropic and Together requests, so small provider charges
may apply. It checks E2B account access without creating a sandbox and checks
Postgres without changing the database.

Run one paid chat task first:

```sh
npm run chat-app
npm run view
```

To try RAG with required result-file checks and a Judge:

```sh
npm run hybrid -- --task rag-search --condition baseline
```

`npm run legacy` runs 12 paid attempts with Judge-led scoring.
`npm run showcase` is an alias for that command. The full `npm run hybrid`
suite runs six attempts. Local runs cannot record trusted HTTP traffic, so
checks that require HTTP observations report skipped instead of passed.

Vision, voice, batch and fine-tuning definitions are included but not enabled
while their verification and resource cleanup are unfinished. Read
[Together tasks, scoring, and costs](evals/together/README.md) before running a
paid suite.

## Backends and development

Local execution and filesystem storage are the defaults. [E2B and
Postgres](docs/beta-backends.md) are optional beta backends.
Use `npm run setup:backends` to install the optional E2B dependencies.
Create a backend Runtime without editing JSON:

```sh
npm run runtime:init -- e2b-postgres --template YOUR_E2B_TEMPLATE
```

Alternatively, set `E2B_TEMPLATE` in `.env.local` and omit `--template`.

For development, `npm run setup:ci` installs locked dependencies. `npm test`
runs tests that do not call paid APIs. `npm run build` builds the Viewer.

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Report
suspected vulnerabilities privately using [SECURITY.md](SECURITY.md).
