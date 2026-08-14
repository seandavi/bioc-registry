# bioc-prop

## Changes to the API REQUIRE updates to the docs

Any change to a route — adding one, removing one, renaming a path or query
parameter, changing a response content type or status code — is not finished
until both of these are updated in the same change:

- `docs/api.md` — the prose reference.
- `OPENAPI` in `src/openapi.ts` — the machine-readable spec that backs `/docs`.

The spec is hand-written, not generated from the handlers, so nothing will fail
if it drifts. It just quietly starts lying to everyone using `/docs` to exercise
the API. Treat a route change with stale docs as an incomplete change.

If the route count grows enough that keeping these in sync by hand gets tedious,
that is the signal to revisit generating the spec from the routes (Hono +
`@hono/zod-openapi`) — deliberately deferred while the surface is ~10 stable routes.

Deliberately **not** in the spec: `/poll`, `/backfill`, `/reindex`, `/seed`. They are
side-effecting GETs with no auth, and publishing them in a try-it UI turns
"reachable if you read the source" into one click for anyone.
