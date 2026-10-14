# Kitchen sink

One Suite that shows most of what Hurdle can do. Five Tasks run under two
Conditions, and each Task is built to reach a particular result, so a single
run shows pass, fail, incomplete and unknown side by side.

| Task | baseline | with-skill | What it shows |
| --- | --- | --- | --- |
| `order-total` | pass | pass | Fixtures, a JSON artifact and exact-value checks |
| `release-notes` | fail | pass | A skill that teaches rules the baseline cannot know |
| `fix-the-bug` | pass | pass | Starter `workspace/` files, a guard against editing the test, `replyIncludes` and an advisory check |
| `oversized-report` | incomplete | incomplete | A required check that returns `null` because its evidence was not captured |
| `summarize-notes` | unknown | unknown | An observation-only Task: every check is advisory |

Agents are real, so results can vary; the table shows the designed results.

Create the example in your project and run it:

```sh
npx hurdle init kitchen-sink --example kitchen-sink
npx hurdle validate kitchen-sink
npx hurdle run kitchen-sink --view
```

Provide Claude Code authentication in `.env.local`. The run makes 10 short
Agent runs (5 Tasks × 2 Conditions), three at a time, with Local execution.
Agent usage may be billed. Run part of the matrix with `--task` or
`--condition`, for example `--task release-notes`.

## How each result happens

- **pass**: every required check passed. Advisory checks, such as
  `one-line-reply` in `fix-the-bug`, are reported but never decide the result.
- **fail**: a required check failed. `release-notes` asks for the house style,
  which only the `house-style` skill describes, so the baseline Agent cannot
  know the codename or sign-off. The `with-skill` Condition installs the skill.
- **incomplete**: a required check could not decide. `oversized-report` caps
  `report.txt` at 1 KB, but the requested report is about 24 KB, so it is not
  captured and `lists-every-number` returns `null` instead of guessing.
- **unknown**: nothing could decide the result. `summarize-notes` declares
  only advisory observations, so it is never scored.

## Not covered here

HTTP request checks, request guards and tool-call checks need a Suite `api`
block and a sandbox that captures traffic; see the `together-api` example.
Judge and hybrid scoring are chosen with the Suite `verdict`; see the
[authoring guide](https://cdn.jsdelivr.net/npm/hurdle@latest/docs/authoring.md).

From the Hurdle repository, run the bundled example directly, or preview every
result for free with a scripted agent that makes no billed requests:

```sh
npm run hurdle -- run examples/kitchen-sink/example.suite.mjs --view
node harness/experiments/preview-cli.mjs run
```
