![TAE — Together Agent Evals. Test how Claude Code and Codex use your API, SDK, or docs.](docs/assets/readme-hero.png)

# Hurdle — Together Agent Evals

Run Claude Code or Codex against real tasks and record what they did. Score each
run with deterministic code, an LLM Judge, or both, then inspect the transcript,
API calls, tool use, and artifacts in a local viewer.

The CLI is packaged on npm as [`hurdle`](https://www.npmjs.com/package/hurdle).
See the [authoring guide](docs/authoring.md) for the `npx hurdle` workflow.

## Quick start

Install Node.js 22.13 or newer and Claude Code, then clone the repository:

```sh
git clone https://github.com/Nutlope/together-agent-evals.git
cd together-agent-evals
cp .env.example .env.local
```

Add either `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` to `.env.local`,
then run:

```sh
npm run quickstart
```

This installs the local dependencies, runs the `copy-message` task, and opens
the results viewer. It does not need a Together key, Judge, E2B account, or
database.

> Local runs execute agent code on your computer with network access. They are
> not a security sandbox. Only run tasks, checks, and Suites you trust.

## How it works

1. A **Task** gives the agent a prompt and any files it needs.
2. A **Suite** chooses the Tasks, agents, models, conditions, repeats, and
   scoring mode.
3. TAE runs the matrix, evaluates the captured evidence, and saves each result
   for review and comparison.

Create a starter Suite and run it with:

```sh
npm run setup
npm run tae -- init
npm run tae -- validate
npm run tae -- run --view
```

Each Task keeps its instructions and evaluation together:

```text
evals/
├── example.suite.mjs
└── tasks/
    └── copy-message/
        ├── prompt.md
        ├── checks.mjs
        └── fixtures/message.txt
```

Checks run against the captured result:

```js
import { defineChecks } from "tae";

export default defineChecks((run) => {
  run.expect.completed();
  run.expect.artifact({
    id: "answer",
    path: "answer.txt",
    format: "text",
    maxBytes: 4096,
  });

  run.check({
    id: "exact-copy",
    passed: run.artifacts.text("answer.txt") === "Hello from the fixture.\n",
    summary: "answer.txt must match the fixture exactly.",
  });
});
```

Use `code` for deterministic checks, `judge` for an LLM rubric, or `hybrid`
when both must pass. Tasks can also block an exact expensive or destructive
request before it reaches the provider.

## Included evaluations

The repository includes Together API tasks for chat, RAG search, tool calling,
and GPU discovery. See [Together evaluations](evals/together/README.md) for the
tasks, costs, credentials, and scoring behavior.

## Documentation

- [Authoring Tasks, Suites, checks, Judges, and request guards](docs/authoring.md)
- [E2B and Postgres setup](docs/beta-backends.md)
- [Copy-message example](examples/copy-message/example.suite.mjs)
- [Contributing](CONTRIBUTING.md) and [security reporting](SECURITY.md)
