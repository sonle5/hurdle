# E2B and Postgres

TAE runs locally and saves results to `.tae/results-v1` by default. You only
need this guide if you want isolated E2B execution, Postgres storage, or both.

| Setup | Execution | Results |
| --- | --- | --- |
| Default | Local | Filesystem |
| E2B | E2B sandbox | Filesystem |
| Postgres | Local | Postgres |
| E2B + Postgres | E2B sandbox | Postgres |

## Before you start

Add the credentials you need to the ignored `.env.local` file:

```sh
ANTHROPIC_API_KEY=...
TOGETHER_API_KEY=...
E2B_API_KEY=...
E2B_TEMPLATE=...
TAE_RESULT_STORE_DATABASE_URL=postgresql://...
```

`ANTHROPIC_API_KEY` and `TOGETHER_API_KEY` are needed by the Together Suites.
Add `E2B_API_KEY` only for E2B and `TAE_RESULT_STORE_DATABASE_URL` only for
Postgres.

## Create a Runtime

Generate the Runtime you need without editing JSON:

```sh
npm run runtime:init -- e2b
npm run runtime:init -- postgres
npm run runtime:init -- e2b-postgres
```

For E2B, set `E2B_TEMPLATE` in `.env.local` to a template in your team that
contains Node 22 and Claude Code. You can instead pass it for one command:

```sh
npm run runtime:init -- e2b-postgres --template YOUR_E2B_TEMPLATE
```

The command writes `.tae/runtime/<kind>.json` and refuses to overwrite an
existing file. It only creates local configuration; it does not create an E2B
template, database, or schema.

Validate every configured service before a run:

```sh
npm run preflight
```

The command reads `.env.local`, with configured values taking precedence over
stale values inherited from the shell. Anthropic and Together make minimal
billable requests. E2B lists account resources without creating a sandbox;
Postgres runs read-only connection and schema checks without applying migrations.
The `tae` CLI uses the same precedence for evaluations.

## E2B with filesystem results

Install the optional E2B dependencies:

```sh
npm run setup:backends
npm run runtime:init -- e2b
```

Then run one cell:

```sh
node harness/bin/tae.mjs run \
  evals/together/hybrid.suite.mjs \
  --runtime .tae/runtime/e2b.json \
  --task rag-search \
  --condition baseline \
  --view
```

Results are saved under `.tae/e2b-results-v1`.

## Postgres with Local execution

Apply the database schema once:

```sh
npm run runtime:init -- postgres
npm run db:migrate
```

Run one cell and open the Postgres-backed Viewer:

```sh
node harness/bin/tae.mjs run \
  evals/together/hybrid.suite.mjs \
  --runtime .tae/runtime/postgres.json \
  --task rag-search \
  --condition baseline \
  --view
```

TAE creates its tables in the `tae` schema, not `public`. Output artifact bytes
remain in the local `.tae/postgres-artifacts` sidecar.

## E2B with Postgres results

Install the optional backend, generate the combined Runtime, and initialize the
database:

```sh
npm run setup:backends
npm run runtime:init -- e2b-postgres
npm run db:migrate
```

Run the same cell with the combined Runtime:

```sh
node harness/bin/tae.mjs run \
  evals/together/hybrid.suite.mjs \
  --runtime .tae/runtime/e2b-postgres.json \
  --task rag-search \
  --condition baseline \
  --view
```

## Reopen results

Use the same Runtime that produced the run:

```sh
node harness/bin/tae.mjs view \
  --runtime .tae/runtime/postgres.json
```

For E2B plus Postgres, replace the Runtime path with
`.tae/runtime/e2b-postgres.json`.

## Verify Postgres

```sql
select table_name
from information_schema.tables
where table_schema = 'tae'
order by table_name;

select id, state, created_at
from tae.runs
order by created_at desc;
```

Migrations are additive and checksum-verified. Do not reset a populated
database or reuse legacy session tables as canonical Run records.

## Beta limitations

E2B, Agent, Judge and Together usage may be billed. A known tool/MCP
process-quiescence defect can mark a run incomplete even when its Judge passes.
Voice, DMI, fine-tuning, Jig and persistent-resource lifecycle Tasks are not
part of the preview. This release does not claim legacy score continuity or
full replacement of the legacy runner.
