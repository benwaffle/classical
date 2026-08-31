# Metadata quality and production operations

## Hard invariants

The production metadata is structurally valid only when all of the following hold:

- every part-linked track belongs to exactly one recording;
- every recording member has at least one part link;
- every linked part belongs to the recording’s work;
- `(work_id, position)` is unique in `work_part_v2`;
- each Spotify track belongs to at most one recording;
- combined tracks may retain multiple part links;
- split movements may link one part to multiple tracks; and
- every stored unlinked track is explicitly terminal `not_classical` rather than silently unexplained.

`pnpm metadata:validate` reports and enforces these structural invariants. A nonzero `needsReview` count is reported but is not itself a structural failure: review flags represent semantic uncertainty that was preserved instead of overwritten.

## Meaning of review status

`confirmed` means the assignment passed deterministic reconciliation. It does not mean the musicological interpretation has been independently verified against a score or authoritative catalog.

`needs_review` is used when:

- a requested canonical position conflicts with an incompatible existing part;
- the pipeline retained an interim/manual fallback link;
- no part was returned and a fallback part had to be synthesized; or
- migration/reparse evidence was ambiguous or less specific than trusted existing metadata.

Do not clear review status in bulk merely to reach zero. Resolve the underlying work, part, or recording ambiguity first.

## Production snapshot

As of 2026-08-30 after the Zimmer/Tchaikovsky/Beethoven cleanup:

| Metric                                                                | Count |
| --------------------------------------------------------------------- | ----: |
| Stored Spotify tracks                                                 | 9,960 |
| Tracks with canonical part links                                      | 9,672 |
| Track-to-part links                                                   | 9,959 |
| Intentionally unlinked Zimmer tracks newly classified `not_classical` |   288 |
| Queue `matched`                                                       | 9,224 |
| Queue `not_classical`                                                 |   394 |
| `needs_review` links                                                  |   170 |
| Part links without recordings                                         |     0 |
| Recording members without parts                                       |     0 |
| Cross-work links                                                      |     0 |
| Duplicate work-part positions                                         |     0 |
| Unclassified unlinked stored tracks                                   |     0 |

This table is an operational snapshot, not a test fixture. Counts will change as albums are added or review items are repaired; the zero-valued invariant rows should remain zero.

## Known quality decisions

- Hans Zimmer was removed from classical metadata. His 288 affected tracks remain as Spotify source rows and terminal `not_classical` queue rows so routine processing does not recreate the assignments.
- The Nutcracker ballet (`Op. 71`) and Nutcracker Suite (`Op. 71a`) are distinct works. Duplicate identities inside each work were merged; the ballet’s `12c` and `12d` are distinct parts.
- Tchaikovsky’s String Quartet No. 1 (`Op. 11`) has one canonical work identity.
- Beethoven’s Ninth (`Op. 125`) has one canonical work identity. Title variants for movements I–IV share canonical parts; explicitly labeled finale subdivisions such as `IVa-b` and `IVc-j` remain separate flat parts.
- Roman numerals are stored labels, not generated from `position`. This prevents duplicated or misleading display numerals.

Material work merges/removals should be recorded in `metadata_migration_audit` with a reason.

## Safe repair procedure

Before mutating production data or schema:

1. Resolve exact composer, work, part, recording, and track IDs with read-only SQL.
2. Take a Turso backup.
3. Write down the expected before/after cardinalities and affected Spotify track IDs.
4. Apply the smallest deterministic transaction possible.
5. Run focused SQL checks for the repaired identities.
6. Run `pnpm metadata:validate`, tests, typecheck, lint, and a production build when application code changed.
7. Record merge/removal decisions in `metadata_migration_audit`.
8. Commit only durable application, migration, test, and documentation changes. Do not commit backups or disposable one-off repair scripts.
9. Push the commit to `master`; production deployment happens through GitHub/Vercel CI.

Backup example:

```bash
turso db export spotify-classical \
  --output-file backups/spotify-classical-YYYY-MM-DD-before-description.db \
  --with-metadata
```

Never run an unconstrained bulk LLM reparse directly over trusted production assignments. A previous full reparse demonstrated that syntactically valid output can still move confirmed tracks between works, drop part links, or fragment canonical identities. Reparse into reviewable candidate data or preserve existing work/part evidence, compare diffs, and accept only deterministic improvements.

## Validation queries

The checked-in validator is the source of truth for automated structural checks. These targeted reports are useful during an incident:

```sql
-- Queue state
SELECT status, count(*)
FROM match_queue
GROUP BY status
ORDER BY status;

-- Review backlog
SELECT count(*)
FROM track_work_part_v2
WHERE match_status = 'needs_review';

-- Cross-work corruption: must return zero
SELECT count(*)
FROM track_work_part_v2 link
JOIN work_part_v2 part ON part.id = link.work_part_id
JOIN recording_track_v2 member ON member.spotify_track_id = link.spotify_track_id
JOIN recording_v2 recording ON recording.id = member.recording_id
WHERE part.work_id <> recording.work_id;

-- Duplicate canonical positions: must return no rows
SELECT work_id, position, count(*)
FROM work_part_v2
GROUP BY work_id, position
HAVING count(*) > 1;
```

## Release checklist for metadata changes

- Production backup exists and is not staged in Git.
- Scope IDs and expected row counts were inspected before mutation.
- Previously confirmed assignments outside the repair scope are unchanged.
- Structural validator exits successfully.
- Parser/normalization/recording fixtures pass.
- Typecheck, lint, and build pass for code changes.
- Queue has no unintentionally stuck `processing` rows.
- Data-only fixes are documented in the audit table.
- Code reaches production only through a push to GitHub.
