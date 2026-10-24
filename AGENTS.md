# AGENTS.md

bioc-registry (package name `bioc-prop`): the Bioconductor package registry. It
watches r-universe's `bioc` and `bioc-release` universes, archives every
observation to R2, gates which versions propagate, and serves the result as a
website, an installable CRAN-style repo (`/repo`), and a Parquet archive
(`/data`, `/sql`). Live at <https://bioc-registry.seandavi.workers.dev>.

Read `README.md` (how it works, the gate, seeds), `CONTRIBUTING.md` (what a good
change looks like) and `CLAUDE.md` before changing anything.

## Stack

- One Cloudflare Worker plus one Workflow, TypeScript, no framework. One R2 bucket
  (`env.ARCHIVE`). Config in `wrangler.jsonc`.
- Runtime dependencies: `hyparquet`, `hyparquet-writer`. Do not add more without
  a reason that a few lines of code cannot cover.
- Node 22+. Tests run TypeScript directly with `node --test --experimental-strip-types`.

## Layout

| path | what |
|---|---|
| `src/repo.ts` | pure logic: `gate()`, DCF/PACKAGES generation, version comparison, delta merging, compaction planning, seed/top-up planning. Unit-tested. |
| `src/index.ts` | the Worker: routes, cron poll, Workflow steps (`evaluate`, `propagateBatch`, log capture, seed, top-up), HTML pages. Wiring; not unit-tested by design. |
| `src/openapi.ts` | the hand-written OpenAPI spec behind `/docs`. |
| `src/*.test.ts` | `node:test` suites, no fixtures, no network. |
| `docs/api.md` | the prose API reference, including storage keys and the index entry shape. |
| `docs/DATAPLANE.md` | the storage/parquet/index contract other producers and consumers read. |
| `scripts/` | ops scripts (`publish.sh`, `requeue.py`) and their fixtures. |

## Commands

```bash
npm ci
npm test                                   # the whole suite, ~1s
npx tsc -p . --noEmit 2>&1 | grep -E '^src/'   # typecheck; only src/ diagnostics count
npm run dev                                # wrangler dev on :8787, empty local R2; hit /poll once
```

`tsc` prints pre-existing noise from `@cloudflare/workers-types` (duplicate
lib.dom identifiers). That is not your problem; a diagnostic under `src/` is.

## Rules

- **Route changes update the docs in the same change**: `docs/api.md` and
  `OPENAPI` in `src/openapi.ts` (see `CLAUDE.md`). `/poll`, `/backfill`,
  `/reindex`, `/seed`, `/topup` stay out of the spec on purpose.
- **Data-plane changes are a public contract**: storage keys, the parquet schema
  and the index entry shape (`docs/DATAPLANE.md`). Adding a field is cheap;
  renaming or removing one breaks readers silently.
- **The gate is one function** (`gate()` in `src/repo.ts`) for every producer:
  r-universe waves (`evaluate`), bioc-build (`POST /publish`), and read-only
  `POST /gate`. Change the rule there, not in a caller. A gate change can flip
  what the registry serves for many packages on the next wave: say how many in
  the PR, measured from the live index and latest observation
  (`/data/prop/{u}/index.json`, `/data/state/{u}/latest` → its `key`).
- Pure logic goes in `src/repo.ts` with one assertion in `src/repo.test.ts` that
  fails when it breaks. Tests never touch the network.
- Comments explain why a rule exists, not what the code does. `ponytail:`
  comments mark a deliberate shortcut and name its ceiling.
- User-facing text (package pages, the dashboard, README, docs) must stay true:
  if a change alters behaviour that prose describes, fix the prose too.
- Deploys are manual and maintainer-only (`wrangler deploy`). Never deploy, and
  never call side-effecting routes on the live Worker.
