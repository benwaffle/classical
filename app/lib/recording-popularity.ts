import { eq, sql } from 'drizzle-orm';
import { db, type DatabaseExecutor } from '@/lib/db';
import { recordingV2 } from '@/lib/db/schema';

/**
 * Recalculate a recording's popularity from its current Spotify track members.
 *
 * Spotify has no recording-level popularity value. The schema has always
 * defined this field as the rounded average of member-track popularity. An
 * empty recording deliberately remains null: there is no evidence to rank it.
 */
export async function refreshRecordingPopularity(
  recordingId: number,
  database: DatabaseExecutor = db,
) {
  await database
    .update(recordingV2)
    .set({
      popularity: sql<number | null>`(
        SELECT CAST(ROUND(AVG(spotify_track.popularity)) AS INTEGER)
        FROM recording_track_v2
        JOIN spotify_track
          ON spotify_track.spotify_id = recording_track_v2.spotify_track_id
        WHERE recording_track_v2.recording_id = ${recordingId}
      )`,
    })
    .where(eq(recordingV2.id, recordingId));
}
