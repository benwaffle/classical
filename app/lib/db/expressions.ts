import { and, countDistinct, eq, sql, type SQLWrapper } from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/sqlite-core';
import { metadataMigrationAudit, recordingV2, recordingTrackV2, trackWorkPartV2 } from './schema';

/**
 * How many of a recording's tracks are actually mapped to a work part.
 *
 * A correlated subquery, so it can be selected or ordered on alongside
 * `recording_v2`.
 *
 * Built through the query builder rather than written as a bare `sql`
 * template on purpose. When a template like that is selected in a query over
 * a single table, Drizzle rewrites its column references to unqualified
 * names — which turned the join condition into `spotify_track_id =
 * spotify_track_id` and the correlation into `recording_id = id`. SQLite
 * rejects that as ambiguous, and every work detail page failed to load. A
 * nested select carries its own qualification and stays correct wherever it
 * is used.
 */
export const mappedTrackCount = sql<number>`${new QueryBuilder()
  .select({ mapped: countDistinct(trackWorkPartV2.spotifyTrackId) })
  .from(recordingTrackV2)
  .innerJoin(trackWorkPartV2, eq(trackWorkPartV2.spotifyTrackId, recordingTrackV2.spotifyTrackId))
  .where(eq(recordingTrackV2.recordingId, recordingV2.id))}`;

/**
 * Whether a review decision has already been recorded for a row.
 *
 * The review backlog is a queue, not a census: a composer whose birth year no
 * source states, or an album that genuinely contributes no matched tracks, is
 * not an outstanding task once someone has looked and written down why. Those
 * decisions live in `metadata_migration_audit`, and this predicate lets the
 * validator count only the gaps nobody has ruled on yet.
 *
 * Built through the query builder for the same reason as `mappedTrackCount`:
 * `metadata_migration_audit` has its own `id` column, so an unqualified
 * correlation would silently compare the wrong one.
 */
export function reviewedAs(entityType: string, decision: string, id: SQLWrapper) {
  return sql`EXISTS ${new QueryBuilder()
    .select({ recorded: sql`1` })
    .from(metadataMigrationAudit)
    .where(
      and(
        eq(metadataMigrationAudit.entityType, entityType),
        eq(metadataMigrationAudit.decision, decision),
        eq(metadataMigrationAudit.sourceId, sql`CAST(${id} AS TEXT)`),
      ),
    )}`;
}
