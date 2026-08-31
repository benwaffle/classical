import { countDistinct, eq, sql } from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/sqlite-core';
import { recordingV2, recordingTrackV2, trackWorkPartV2 } from './schema';

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
