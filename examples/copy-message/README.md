# Copy a message

A product-neutral code-checked Task. It needs Claude Code authentication, but
no Together key, Judge, database or sandbox account. To use Codex instead,
change the Suite's runner to `codex` and provide its authentication.

From the source checkout root after setup, run these commands, replacing
`my-evals` with the directory where you created this Suite:

```sh
npm run tae -- validate my-evals/example.suite.mjs
npm run tae -- run my-evals/example.suite.mjs --view
```
The Suite defines the matrix; `--task`, `--condition`, `--agent` and `--model`
only filter existing selections. This starter runs once; set `repeats` in the
Suite to run independent repeats.

Local execution runs code on your host with network access; it is not a security
sandbox. Use only trusted Suites, checks and task inputs.
