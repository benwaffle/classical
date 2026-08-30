# Work-parts v2 migration

The migration is intentionally additive. Do not enable v2 reads until the validation command passes.

## Production runbook

1. Export a recoverable database backup before applying the schema:

   ```sh
   mkdir -p backups
   turso db export spotify-classical --output-file backups/spotify-classical-before-work-parts.db --with-metadata
   ```

2. Stop all `queue:drain` workers. Page loads may continue adding pending queue rows.

3. Apply the additive migration and seed fallback assignments:

   ```sh
   pnpm db:migrate
   pnpm metadata:v2 --seed --validate
   ```

4. Reparse albums. The audit table makes this resumable; completed albums are skipped unless `--force` is supplied:

   ```sh
   pnpm metadata:v2 --reparse --max-albums 10
   pnpm metadata:v2 --reparse
   ```

   Use `--album <spotify-id>` to retry one album and `--dry-run` to inspect the selected work without writes.

5. Review the validation report:

   ```sh
   pnpm metadata:v2 --validate
   turso db shell spotify-classical "SELECT match_status, count(*) FROM track_work_part_v2 GROUP BY match_status"
   turso db shell spotify-classical "SELECT decision, count(*) FROM metadata_migration_audit GROUP BY decision"
   ```

   `candidateTracks` must equal `storedTracks`, and `crossWorkLinks` must be zero. Add adjudicated work-ID overrides to `scripts/work-parts-migration-manifest.json` and rerun affected albums when needed.

6. Deploy, smoke-test liked songs and the admin work editor, then resume `queue:drain`.

7. After a successful release and a fresh backup, remove the legacy movement, track-movement, and recording tables.
