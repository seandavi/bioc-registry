# Contributing

Thanks for helping. This is a small codebase on purpose — a Cloudflare Worker,
a Workflow, an R2 bucket, and no framework. Please keep it that way.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
Contributions are accepted under the [Apache License 2.0](LICENSE).

## Getting set up

```bash
git clone https://github.com/seandavi/bioc-registry
cd bioc-registry
npm install
npm test        # node --test, no framework, no fixtures
npm run dev     # wrangler dev --test-scheduled, on http://localhost:8787
```

`npm run dev` talks to a local R2 simulation, so it starts with an empty bucket:
hit `/poll` once to pull a real observation from r-universe and populate it.
That single poll is enough to exercise the dashboard, `/sql`, and `/repo`.

Node 22+ (the tests use `--experimental-strip-types` to run TypeScript directly).

## What a good change looks like

- **Small.** A fix that touches one file beats a refactor that touches six.
- **Tested where the logic is real.** Pure functions live in `src/repo.ts` and
  are tested in `src/repo.test.ts` — gate evaluation, DCF generation, delta
  merging, compaction planning. If your change adds a branch, a parser, or a
  version comparison, add the one assertion that fails when it breaks. Wiring
  code in `src/index.ts` (handlers, HTML) is not unit-tested by design.
- **Documented when it changes the surface.** See the next section — this one
  is enforced by review, not by CI.
- **Commented where the reason isn't obvious.** The existing comments explain
  *why* a rule exists (why BiocCheck is advisory, why rows are stored as
  deltas). Match that; skip comments that restate the code.
- `ponytail:` comments mark a deliberate shortcut and name its ceiling. If you
  take one, say what would force the upgrade.

## Changing a route means changing the docs

Adding, removing, or renaming a route — or changing a query parameter, response
content type, or status code — is not finished until **both** of these are
updated in the same PR:

- [`docs/api.md`](docs/api.md) — the prose reference
- `OPENAPI` in [`src/openapi.ts`](src/openapi.ts) — the spec behind `/docs`

The spec is hand-written, not generated, so nothing fails when it drifts; it
just quietly starts lying to everyone using the try-it panel. See
[CLAUDE.md](CLAUDE.md).

Side-effecting maintenance routes (`/poll`, `/backfill`, `/reindex`) are
deliberately absent from the spec — they are gated on a shared secret and do not
belong in a one-click try-it UI.

## Data-plane changes

Storage keys, the parquet schema, and the index entry shape are a public
contract — other producers and consumers read them (see
[docs/DATAPLANE.md](docs/DATAPLANE.md)). Adding a column or a field is cheap;
renaming or removing one breaks readers silently, because parquet readers union
by name and simply see nulls. If you must, open an issue first.

## Pull requests

1. Branch off `main`.
2. `npm test` passes.
3. Describe what changed and, if it touches the gate or the schema, what a
   consumer would notice.

Deploys are manual and maintainer-only — you do not need Cloudflare credentials
to contribute.

## Reporting bugs and asking for features

Open an [issue](https://github.com/seandavi/bioc-registry/issues). Useful
things to include: the URL you hit, what you expected, what you got, and — if
it is about a specific package — the universe (`bioc` or `bioc-release`) and
package name, so the report can be checked against
`/pkg/{universe}/{package}`.
