# Results Viewer

A read-only local Next.js app for stored Run Records: initial prompt, transcript,
tool breakdown, checks/Judge, captured source and evidence metadata. It never
runs evaluations, edits verdicts, imports historical sessions or migrates a DB.

After source setup, from the repository root:

```sh
npm run view
npm --prefix harness exec -- hurdle view --store /absolute/path/to/.hurdle/results-v1
```

The launcher binds to loopback and reports the URL; open that link in your
browser. Use the same `--runtime`
file as the run to select an opt-in Postgres store. `DATABASE_URL` does not select
that store; no legacy database fallback is present.

For Viewer-only development, set `TAE_RESULT_STORE_MODE=local` and an absolute
`TAE_RESULT_STORE_ROOT`, then use `npm --prefix viewer run dev`.
`npm --prefix viewer run build` builds it. An absent store shows setup guidance;
the Viewer never creates it. There is no static run-data directory or sync step.

Local-only is not authentication: other processes/users with access to the
machine can read the loopback Viewer. Do not expose it through a public proxy.
See the root README and [beta backends](../docs/beta-backends.md).
