![Hurdle — Together Agent Evals. Test how Claude Code and Codex use your API, SDK, or docs.](https://cdn.jsdelivr.net/npm/hurdle@0.2.1/docs/assets/readme-hero.png)

# Hurdle — Together Agent Evals

Run Claude Code or Codex against real tasks and record what they did. Score each
run with deterministic code, an LLM Judge, or both, then inspect the transcript,
API calls, tool use, and artifacts in a local viewer.

The CLI is packaged on npm as [`hurdle`](https://www.npmjs.com/package/hurdle).
See the [authoring guide](https://cdn.jsdelivr.net/npm/hurdle@latest/docs/authoring.md) for Tasks, Suites, and configuration.

## Quick start

Install Node.js 22.13 or newer and Claude Code, then create an evaluation in
an empty directory or your existing project:

```sh
mkdir my-evals && cd my-evals
npx hurdle init
```

Add either `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` to `.env.local`.
For subscription authentication, generate the token with `claude setup-token`.
Keep `.env.local` out of version control. Hurdle uses isolated agent
configuration, so an interactive CLI login alone is not inherited.

```sh
npx hurdle validate
npx hurdle run --view
```

`validate` checks definitions, setup, and API-key authentication without running
an agent. `run` repeats those checks before starting. Subscription tokens are
checked for configuration; their live validity is not verified.

The starter asks the agent to copy a fixture into `answer.txt`, scores the exact
copy, and opens the results viewer. It does not need a Together key, Judge, E2B
account, or database. Agent usage may be billed by your provider.

For Codex, install its CLI and use `npx hurdle init --agent codex` instead.
Configure `CODEX_ACCESS_TOKEN`, `CODEX_API_KEY`, or `OPENAI_API_KEY` in `.env.local`
(checked in that order), then use the same validate and run commands.

> Local runs execute agent code on your computer with network access. They are
> not a security sandbox. Only run tasks, checks, and Suites you trust.

## How it works

1. A **Task** gives the agent a prompt and any files it needs.
2. A **Suite** chooses the Tasks, agents, models, conditions, repeats, and
   scoring mode.
3. Hurdle runs the matrix, evaluates the captured evidence, and saves each result
   for review and comparison.

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
import { defineChecks } from "hurdle";

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
and GPU discovery. See [Together evaluations](https://github.com/Nutlope/together-agent-evals/blob/main/evals/together/README.md) for the
tasks, costs, credentials, and scoring behavior.

To work from source or run the included evaluations, clone the repository
(repository access is required while it is private):

```sh
git clone https://github.com/Nutlope/together-agent-evals.git
cd together-agent-evals
cp .env.example .env.local
npm run setup
```

Add your agent credentials to `.env.local`, then try the starter from source:

```sh
npm run hurdle -- validate examples/copy-message/example.suite.mjs
npm run hurdle -- run examples/copy-message/example.suite.mjs --view
```

## Documentation

- [Authoring Tasks, Suites, checks, Judges, and request guards](https://cdn.jsdelivr.net/npm/hurdle@latest/docs/authoring.md)
- [E2B and Postgres setup](https://cdn.jsdelivr.net/npm/hurdle@latest/docs/beta-backends.md)
- [Copy-message example](https://cdn.jsdelivr.net/npm/hurdle@latest/examples/copy-message/example.suite.mjs)
- [Contributing](https://cdn.jsdelivr.net/npm/hurdle@latest/CONTRIBUTING.md) and [security reporting](https://cdn.jsdelivr.net/npm/hurdle@latest/SECURITY.md)
