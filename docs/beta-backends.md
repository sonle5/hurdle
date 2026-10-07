# E2B and Postgres

Hurdle runs locally and saves results to `.tae/results-v1` by default. Follow this
guide only when you need isolated E2B execution, Postgres storage, or both.

| Runtime | Execution | Result store |
| --- | --- | --- |
| Default | Local | Filesystem |
| `e2b` | E2B | Filesystem |
| `postgres` | Local | Postgres |
| `e2b-postgres` | E2B | Postgres |

## 1. Configure credentials

Add only the services you use to the ignored `.env.local` file:

```sh
ANTHROPIC_API_KEY=...
TOGETHER_API_KEY=...
E2B_API_KEY=...
E2B_TEMPLATE=...
TAE_RESULT_STORE_DATABASE_URL=postgresql://...
```

The Together Suites need the Anthropic and Together keys. E2B needs
`E2B_API_KEY` and `E2B_TEMPLATE`. Postgres needs
`TAE_RESULT_STORE_DATABASE_URL`.

Install the optional backend packages:

```sh
npm run setup:backends
```

## 2. Create a Runtime

Choose one command:

```sh
npm run runtime:init -- e2b
npm run runtime:init -- postgres
npm run runtime:init -- e2b-postgres
```

The command writes `.tae/runtime/<kind>.json` and refuses to overwrite an
existing file.

Your E2B template must contain Node.js 22 and Claude Code. Set its name with
`E2B_TEMPLATE`, or pass it directly:

```sh
npm run runtime:init -- e2b --template YOUR_E2B_TEMPLATE
```

Runtime initialization creates local configuration only. It does not create an
E2B template, database, or schema.

## 3. Initialize Postgres

Skip this step for filesystem storage. For either Postgres Runtime, apply the
schema once:

```sh
npm run db:migrate
```

Hurdle creates tables in the `tae` schema, not `public`. Output artifact bytes
stay in the local `.tae/postgres-artifacts` sidecar.

Migrations are additive and checksum-verified. Do not reset a populated database
or reuse legacy session tables as canonical Run records.

## 4. Verify the setup

```sh
npm run preflight
```

Preflight checks only configured services. Anthropic and Together make small
billable requests. E2B lists account resources without allocating a sandbox.
Postgres checks the connection and schema without applying migrations.

Values in `.env.local` take precedence over stale values inherited from the
shell. Evaluation runs use the same precedence.

## 5. Run one cell

Set the Runtime path you created, then run a RAG cell:

```sh
RUNTIME=.tae/runtime/e2b.json

npm run hurdle -- run \
  evals/together/hybrid.suite.mjs \
  --runtime "$RUNTIME" \
  --task rag-search \
  --condition baseline \
  --view
```

Use `.tae/runtime/postgres.json` or
`.tae/runtime/e2b-postgres.json` for the other configurations.

Filesystem-backed E2B results are saved in `.tae/e2b-results-v1`. Postgres
results are written to the configured database.

## Reopen results

```sh
npm run hurdle -- view --runtime .tae/runtime/postgres.json
```

Use the same Runtime file that produced the run.

To verify Postgres directly:

```sql
select table_name
from information_schema.tables
where table_schema = 'tae'
order by table_name;

select id, state, created_at
from tae.runs
order by created_at desc;
```

## Beta limitations

E2B, Agent, Judge, and Together usage may be billed. A known tool/MCP
process-quiescence defect can mark a run incomplete even when its Judge passes.

Voice, DMI, fine-tuning, Jig, and persistent-resource lifecycle Tasks are
outside the preview. This release does not claim legacy score continuity or full
replacement of the legacy runner.
