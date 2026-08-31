# Metadata ingestion and reconciliation pipeline

## Runtime ownership

The production processor runs in Vercel through `/api/cron/match-queue`; the CLI drain script is for deliberate local/manual operations, not the normal production worker.

Production code is deployed by pushing commits to the repository’s `master` branch and allowing the GitHub/Vercel integration to deploy. Do not deploy production with `vercel deploy`.

The route requires `Authorization: Bearer $CRON_SECRET`, uses the Node.js runtime, and has a five-minute maximum duration. Vercel invokes a daily recovery run at `06:00 UTC`. User submissions also dispatch the route immediately.

## End-to-end flow

1. A signed-in user submits one or more unmatched Spotify tracks.
2. The submission expands each track to its complete Spotify album. Album context is essential for sparse titles such as `Kyrie` or `I. Allegro`.
3. Every album track gets one `match_queue` row. Existing terminal rows are not blindly reset.
4. A worker atomically claims one pending album, increments attempts, records `last_attempt_at`, and assigns a unique lease owner.
5. Spotify album and track metadata are fetched. Tracks are sorted by `(disc_number, track_number)`.
6. Tracks that already have part links are left unchanged and marked `matched`.
7. The remaining tracks are parsed by the LLM with the complete album outline, even when the request is split into batches of 20 tracks.
8. Base Spotify, composer, and work rows are saved while preserving a compatible existing work assignment.
9. The v2 reconciliation pass resolves canonical works and parts, groups tracks into recordings, replaces each processed track’s part links, and assigns review status.
10. Tracks with a usable link become `matched`. Non-classical tracks become terminal `not_classical`. Errors become `pending` or `failed` according to retryability.
11. After successfully processing one album, the Vercel route calls itself to drain the next album. It stops when the queue is empty or a retryable failure indicates backoff is needed.

## LLM contract

The parser returns one object for every requested input track:

- classical/non-classical classification;
- composer and complete-work identity;
- a primary catalog identifier when known;
- an album-local recording group; and
- zero or more flat parts with `position`, `label`, and `title`.

Important prompt rules:

- `formalName` identifies the complete work, not the album, collection, excerpt heading, or movement.
- `label` contains printed numbering/structure only. Tempo, form, key, and descriptive words belong in `title`.
- Hierarchical identifiers are preserved (`III.2`, not a newly generated `IV`).
- A track containing several leaf parts returns several part objects.
- `position` is flattened canonical leaf order, not the numeric value of a top-level Roman section.
- The same performance uses a stable album-local `recordingGroup` across batches.
- Film, television, and game soundtrack cues are not classified as classical merely because they use an orchestra. Hans Zimmer soundtrack music is explicitly excluded from this catalog.

The parser retries transient gateway/rate-limit failures with bounded backoff. Missing batch outputs are errors; the pipeline does not silently drop requested tracks.

Spotify’s consumer “Show credits” UI may expose composition details that are not present in the ordinary track title or the Spotify Web API payload used here. The current pipeline compensates with full-album context and the LLM; it does not scrape the consumer UI.

## Work and part safety rules

Fresh parser output is evidence, not authority.

- Existing work assignments are preferred when composer and titles remain compatible and the new candidate is at least as specific.
- Catalog lookups use normalized `work_catalog_v2` values and migration mappings.
- Ambiguous work resolution returns unresolved instead of selecting an arbitrary candidate.
- Part matching never uses position alone.
- Existing canonical positions are preserved when the parser changes only a title variant.
- A contradictory position collision creates a reviewable part instead of overwriting trusted metadata.
- If a base-save/manual link survives reconciliation, it is marked `needs_review`.
- If the parser returns no parts for a classical track, the pipeline synthesizes a single fallback part and marks it `needs_review`.

The parser occasionally assigns every part of an N-part work to each of N sequential tracks. The pipeline collapses only the exact symmetric Cartesian pattern. Genuine combined or asymmetric assignments remain many-to-many.

## Recording grouping

The LLM supplies an album-local `recordingGroup`. Groups for the same work are merged only when their normalized token overlap is strong or their part positions clearly continue in sequence.

Within a group, Spotify disc/track order is authoritative. The reconciler then matches an existing recording by exact membership, followed by unique greatest overlap. Ties create a new recording rather than guessing.

## Queue recovery and retries

- A `processing` lease older than 30 minutes is recovered to `pending` by the authenticated GET recovery path.
- Failed rows below five attempts can be retried.
- Pending rows at five attempts become exhausted `failed` rows.
- Network, timeout, rate-limit, and common 5xx failures return the album to `pending`.
- Deterministic metadata/save failures become `failed`.
- `not_classical` is terminal and must not be requeued by routine recovery.

Useful commands:

```bash
# Inspect queue state
turso db shell spotify-classical \
  "SELECT status, count(*) FROM match_queue GROUP BY status ORDER BY status"

# Validate canonical metadata using the configured production database
pnpm metadata:validate

# Manual/local drain only; production normally drains in Vercel
pnpm queue:drain
```
