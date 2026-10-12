![Hurdle. Test how Claude Code and Codex use your API, SDK, or docs.](https://cdn.jsdelivr.net/npm/hurdle@0.2.7/docs/assets/readme-hero.png)

# Hurdle — Together Agent Evals

Evaluate Claude Code and Codex on real tasks. Score results and inspect transcripts,
API calls, tool use, and artifacts in the results viewer.

## Quick start

Requires Node.js 22.13+ and Claude Code.

```sh
mkdir my-evals && cd my-evals
npx hurdle init
```

Set `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` in `.env.local`.
For subscription access, generate a token with `claude setup-token`.

```sh
npx hurdle validate
npx hurdle run --view
```

Results are saved in `.hurdle/`. Local execution is not a security sandbox;
use trusted tasks and keep credentials out of version control. Agent usage may be billed.

Check your installed version with `npx hurdle --version` (or `npx hurdle version`).

For Codex, install its CLI, use `npx hurdle init --agent codex`, and set `OPENAI_API_KEY` instead.
See [authoring](https://cdn.jsdelivr.net/npm/hurdle@latest/docs/authoring.md) for other authentication options.

Starters pin Claude Opus 5.5 or GPT-6.1 Sol with medium reasoning effort.
Use `init --model MODEL --effort LEVEL` to choose another configuration.

## Together sandbox

In a new project, add `TOGETHER_API_KEY` and your agent credentials to `.env.local`:

```sh
npx hurdle init --example together-api
npx hurdle setup --yes
npx hurdle run --view
```

Setup builds or reuses a Together snapshot. Sandbox and API usage may be billed.
For E2B, add `E2B_API_KEY` and use `npx hurdle setup --sandbox e2b --yes`.
See [setup](https://cdn.jsdelivr.net/npm/hurdle@latest/docs/sandbox-setup.md) for existing templates and Postgres.

For an existing Postgres database, set `HURDLE_RESULT_STORE_DATABASE_URL` in `.env.local`,
then run `npx hurdle setup --store postgres`.

## Tasks and checks

A Suite selects Tasks and agents. Each Task keeps its prompt, fixtures, and checks together:

```text
evals/
├── example.suite.mjs
└── tasks/
    └── copy-message/
        ├── prompt.md
        ├── checks.mjs
        └── fixtures/message.txt
```

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

Score with `code`, an LLM `judge`, or `hybrid` checks.

## From source

Repository access is required while it is private.

```sh
git clone https://github.com/Nutlope/together-agent-evals.git
cd together-agent-evals
cp .env.example .env.local
npm run setup
```

Add your agent credentials to `.env.local`, then run the starter:

```sh
npm run hurdle -- validate examples/copy-message/example.suite.mjs
npm run hurdle -- run examples/copy-message/example.suite.mjs --view
```

## Documentation

- [Authoring](https://cdn.jsdelivr.net/npm/hurdle@latest/docs/authoring.md)
- [Sandbox and storage setup](https://cdn.jsdelivr.net/npm/hurdle@latest/docs/sandbox-setup.md)
- [Contributing](https://cdn.jsdelivr.net/npm/hurdle@latest/CONTRIBUTING.md) · [Security](https://cdn.jsdelivr.net/npm/hurdle@latest/SECURITY.md)
