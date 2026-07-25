# Studio Host Architecture

How `prisma-sharding` and `@prisma-sharding/studio` combine into one Studio that serves every
configured shard.

## The problem this replaces

The previous `prisma-sharding-studio` spawned one `npx prisma studio` child process per
shard, on sequential ports. Three shards meant three processes, three ports, three browser
tabs, and no way to tell at a glance which tab was pointed at which database. Comparing two
shards meant window management; a stale tab looked identical to a live one.

## Ownership

The split is strict, and it is what keeps the two packages independently maintainable.

`@prisma-sharding/studio` is a rename of Prisma's `@prisma/studio-core`, published under our
own scope so it is never confused with, or published over, the official package. The rename
carries no behavioural change; the fork exists only to host the generic extension points
listed below. Upstream attribution is preserved in that package's `NOTICE` and `LICENSE`.

| Concern                                                        | Owner                     |
| -------------------------------------------------------------- | ------------------------- |
| Shard discovery, de-duplication, environment loading            | `prisma-sharding`         |
| Shard identifier validation, credential resolution, routing     | `prisma-sharding`         |
| Project identity, host lifecycle, port scanning, process reuse  | `prisma-sharding`         |
| CLI integration and the browser shell around Studio             | `prisma-sharding`         |
| Studio UI, adapters, introspection, table editor, SQL tools     | `@prisma-sharding/studio` |
| BFF contract, executor contract, serialized error contract      | `@prisma-sharding/studio` |
| Routing, authentication, tenancy for an embedded deployment     | the consuming host        |

`@prisma-sharding/studio` stays database-agnostic and sharding-agnostic. It has no dependency on
`prisma-sharding` and no knowledge that shards exist. `prisma-sharding` consumes only public
`@prisma-sharding/studio` exports and copies none of its source.

## Studio extension points used

Two additive, generic APIs were added to `@prisma-sharding/studio`. Neither mentions sharding,
and both are useful to any embedder that owns connection selection or navigation:

- `StudioProps.headerEndContent` — an opaque `ReactNode` rendered at the end of every Studio
  header. Studio never inspects it. The shard selector lives here; a different embedder
  might put an environment badge or a tenant picker there.
- `StudioProps.onPendingChangesChange` — reports unsaved staged inserts and edits. Any host
  that can navigate away from a Studio session needs this to avoid silently discarding work.

Everything else uses contracts Studio already published: `createStudioBFFClient` with
`customPayload` for host context, `createPostgresAdapter` over that client, and Studio's
documented behaviour of clearing connection-bound state when the adapter changes.

## Request path

```text
Browser
  shard selector  ──selects──▶  shard session (adapter + BFF client, bound to one shard ID)
        │
        ▼  POST /api/studio/bff   { procedure, ..., customPayload: { shardId } }
Studio host (prisma-sharding, server-side)
  1. reject client-supplied connection URLs
  2. read shard ID from customPayload or x-prisma-shard-id (conflicts rejected)
  3. resolve the ID against server-owned configuration   ← nothing unknown gets past here
  4. authorize (required for network-reachable mounts)
  5. acquire the bounded, lazy connection for that shard
  6. execute exactly one procedure against exactly one database
```

Steps 1–4 happen before any database work. An unknown, stale or malformed identifier never
reaches a connection.

## Modules

### Server (`src/studio-host/`)

| Module                            | Responsibility                                                    |
| --------------------------------- | ----------------------------------------------------------------- |
| `studioHostTargets.ts`            | Discovery, de-duplication, identifier resolution                   |
| `studioHostManifest.ts`           | The credential-free payload the browser is allowed to see          |
| `studioHostIdentity.ts`           | Credential-free fingerprint of project + schema + whole shard set  |
| `studioHostConnectionPool.ts`     | Lazy, bounded, idle-expiring connections keyed by shard            |
| `studioHostConnectionString.ts`   | Consumes Prisma driver arguments postgres.js would reject          |
| `studioHostShardUrl.ts`           | How the shard is represented in the URL, and what a switch preserves |
| `studioHostPostgresConnection.ts` | The only module that sees a connection string                      |
| `studioHostBff.ts`                | One Studio procedure against one already-validated executor        |
| `studioHostService.ts`            | Validation, authorization, routing — shared by CLI and embedders   |
| `studioHostHttp.ts`               | Node HTTP transport over the service                               |
| `studioHostAssets.ts`             | Serves the pre-built browser bundle, with traversal blocked        |
| `studioHostServer.ts`             | The single HTTP server the CLI starts                              |

### Browser (`src/studio-host/shell/`)

| Module                              | Responsibility                                             |
| ----------------------------------- | ---------------------------------------------------------- |
| `studioShellApp.tsx`                | Active shard, switching, remount-on-switch                 |
| `studioShellShardSelector.tsx`      | Accessible listbox in the Studio header slot               |
| `studioShellShardSession.ts`        | Per-shard adapter and abortable, shard-tagged transport    |
| `studioShellUnsavedChangesDialog.tsx` | Keep-editing / discard confirmation                      |
| `studioShellUrlState.ts`            | Shard in the query string, Studio state in the hash        |
| `studioShellCapabilities.ts`        | Degrades honestly on a studio-core without the extensions  |

## Design decisions worth knowing

**The shard lives in the query string, not the hash.** Studio's nuqs adapter rewrites the
entire hash on every navigation, so a shard stored there would be erased by the first table
click. The query string is untouched by that adapter.

That split also makes the two kinds of state independent, which is what lets a switch change
the database without moving the user: `buildStudioShardUrl` rewrites only the `shard`
parameter and passes the hash through byte-for-byte, so view, schema, table, filters and
sorting survive. The hash is deliberately not parsed or re-encoded — Studio writes that
fragment and expects to read back exactly what it wrote. When the new shard lacks the
selected schema or table, `useNavigation` already falls back to the first available one, so
a preserved hash degrades rather than breaking.

**Switching remounts Studio.** Studio builds its collections, caches and query client per
provider instance, so a new instance is the strongest available guarantee that rows,
introspection metadata, filters and selections cannot cross databases — including when two
shards have byte-identical schemas. localStorage-backed preferences (theme, navigation
width, page size) survive the remount by design.

**Sessions refuse late responses.** Each shard session owns its in-flight requests. Disposal
aborts them and marks the session stale, so a response that was already on the wire when the
user switched is discarded instead of applied to the new shard's UI.

**The host does not save on the user's behalf.** Committing staged rows is a per-table
Studio action with its own validation and error handling. A host-driven "save everything"
would hide failures behind a dialog, so the confirmation offers *keep editing* (return to
the edits and save them properly) or *discard and switch*. Nothing is dropped silently.

**Reuse is fingerprinted over the whole shard set.** Per-shard Studio fingerprinted one
project and one database. A host serves all of them, so reuse requires the entire configured
set to match. Adding, removing or repointing a shard produces a different host.

**Connections are lazy.** Starting Studio for a 40-shard project costs one HTTP server and
zero database connections. The first query against a shard opens its connection; the bound
and the idle sweep close what is no longer being used.

**Prisma's connection-string arguments are consumed, not forwarded.** The host connects
through `postgres.js`, which sends every query parameter it does not recognise to the server
as a startup parameter. A stock Prisma URL ending in `?schema=public` therefore fails the
connection itself with `unrecognized configuration parameter "schema"`, before Studio can
introspect anything. `studioHostConnectionString.ts` translates what has an equivalent
(`schema` becomes the default `search_path`, `connection_limit` becomes the pool size),
drops what describes Prisma engine behaviour (`pgbouncer`, `pool_timeout`), and passes
everything else through so genuine PostgreSQL settings still reach the server. This is the
one behavioural difference the driver change introduced, and it is invisible to consumers:
existing `.env` files work unchanged.

**Query insights are refused, not faked.** The host does not observe SQL executed outside
Studio, so the browser leaves the provider disabled and the Queries view stays hidden. The
procedure returns `501` rather than an empty snapshot.

## Testing

- `test/studio-host.test.js` — discovery, de-duplication, manifest sanitization and its
  fail-loud guard, identifier rejection, connection-URL injection, authorization ordering,
  BFF procedure semantics, pool bounds and disposal, leak checks under rapid switching.
- `test/studio.test.js` — single-URL output, credential-free manifest over HTTP, HTTP-level
  rejection cases, port scanning around a foreign occupant, cross-project isolation,
  identity-verified reuse, shard-set change invalidating reuse, clean shutdown.
- `studio-main` — `ui/studio/StudioHeader.test.tsx` for the header slot's isolation from
  view-owned content, `ui/studio/studio-pending-changes.test.ts` for the reporter.
