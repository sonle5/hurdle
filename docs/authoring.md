# Authoring evaluations

Create a starter evaluation from the repository root:

```sh
npm run setup
npm --prefix harness exec -- tae init my-evals
```

An evaluation has two parts: a **Suite** selects what to run, and each **Task**
defines a prompt and its checks.

## 1. Define a Suite

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

- `tasks` contains paths relative to the Suite file.
- `agents` selects the runner and, optionally, its model.
- `conditions` defines the skills and MCP servers available to the Agent.
- `repeats` runs every selected cell independently, even after a failure.
- `verdict` chooses code checks, a Judge, or both.

An empty `skills` array creates a no-skills baseline. Skills and MCP servers are
selected independently.

## 2. Write a Task

```text
tasks/copy-message/
├── prompt.md
├── checks.mjs
├── guard.mjs       # optional
├── fixtures/
│   └── message.txt
└── workspace/
```

Write the Agent's instructions in `prompt.md`. Put read-only inputs in
`fixtures/`; they appear under `fixtures/` during the run. Files in `workspace/`
are placed at the workspace root, which is useful when the prompt names an exact
path.

Every Task needs `prompt.md` and `checks.mjs`. Add `guard.mjs` only when the
Task must prevent a request. Symlinks and overlapping staged paths are rejected.

## 3. Write deterministic checks

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

This example checks that the Agent exited cleanly, captured `answer.txt`, and
wrote the exact expected text. Declare an artifact before reading it.

Checks run against captured results, not the live Agent workspace. Keep them
deterministic: do not import arbitrary helpers, make network calls, or access
credentials. The built-in helpers also cover reply text, HTTP requests, and
tool calls:

```js
run.expect.replyIncludes("in stock");
run.expect.request({ id: "chat", method: "POST", path: "/v1/chat/completions", status: 200 });
run.expect.tool("lookup_inventory", { count: 1 });
```

Required request and tool checks need a Runtime that can capture trusted
traffic, such as E2B. Native Local runs cannot prove those observations.

### Block an expensive or destructive request

Put preventive policy in `guard.mjs`, separate from the checks that inspect the
completed run:

```js
import { defineGuard } from "tae";

export default defineGuard((guard) => {
  guard.block.request({
    id: "no-reservation",
    method: "POST",
    path: "/v1/compute/clusters",
  });
});
```

During an E2B run, the Guardian returns a synthetic `403` before it substitutes
the real API credential or contacts the target. TAE automatically records a
deterministic check for every guard: it passes when the Agent never tries the
request and fails when the Guardian blocks an attempt. The blocked attempt is
retained as trusted, payload-free request evidence.

Blocking is deliberately narrow in this release: `method` and `path` are exact,
the path cannot contain a query or fragment, and request bodies are not
inspected. A Task that declares a blocker requires the E2B Runtime; Local runs
are rejected before the Agent starts.

## 4. Choose how a run is scored

- `code`: required code checks decide the result. No Judge runs.
- `judge`: `run.judge(rubric)` decides the result. Code checks are advisory.
- `hybrid`: required code checks and the Judge must both pass.

For `judge` or `hybrid`, add both a rubric and a Judge model:

```js
// checks.mjs
run.judge("Pass only when the answer clearly explains the quoted price.");

// example.suite.mjs
verdict: "hybrid",
judge: { model: "claude-opus-4-8" },
```

Configure the Judge credential in the Runtime. Run Trust is always enforced, so
execution, evidence-capture, or cleanup failures cannot become a pass.

Results stay distinct:

- `pass`: the configured scoring requirements passed.
- `fail`: the evidence proves a required check or Judge failed.
- `incomplete`: required execution, evidence, or Judge data was unavailable.
- `unknown`: there was not enough scoring authority to decide.

## 5. Run, inspect, and compare

```sh
npm --prefix harness exec -- tae run my-evals/example.suite.mjs --view
```

Use `--task`, `--condition`, `--agent`, or `--model` to narrow selections already
defined by the Suite. These flags do not add new Suite entries.

Label runs that you want to compare:

```sh
npm --prefix harness exec -- tae run my-evals/example.suite.mjs --experiment-version before
npm --prefix harness exec -- tae run my-evals/example.suite.mjs --experiment-version after
```

Open **Compare** in the Viewer and select the two labels. Runs are compared only
when their saved evaluation definitions are compatible; a matching label alone
does not make two runs equivalent.

## Credentials and safety

Declare a target API only when a Task needs it:

```js
api: {
  authorizationCredential: "YOUR_API_KEY",
  hosts: ["api.example.com"],
},
```

Supply the value through the Runtime or `.env.local`; never commit it. The
framework redacts known credentials from newly captured evidence, but you should
still avoid asking Agents to print secrets and review results before sharing
them.

Local runs execute Agent code on the host and are not a security sandbox. Use
the optional E2B Runtime when you need isolation or trusted HTTP/tool evidence.
