import { loadEnvConfig } from '@next/env';

async function main() {
  loadEnvConfig(process.cwd());
  if (!process.env.TURSO_DATABASE_URL) {
    throw new Error('TURSO_DATABASE_URL is required');
  }

  const [{ db }, schema, drizzle] = await Promise.all([
    import('@/lib/db'),
    import('@/lib/db/schema'),
    import('drizzle-orm'),
  ]);
  const { and, count, countDistinct, eq, isNull, ne, or, sql } = drizzle;

  const [
    [storedTracks],
    [linkedTracks],
    [partLinks],
    [tracksWithoutRecording],
    [recordingTracksWithoutParts],
    [crossWorkLinks],
    [duplicatePositions],
    [needsReview],
    [unclassifiedUnlinkedTracks],
  ] = await Promise.all([
    db.select({ value: count() }).from(schema.spotifyTrack),
    db
      .select({ value: countDistinct(schema.trackWorkPartV2.spotifyTrackId) })
      .from(schema.trackWorkPartV2),
    db.select({ value: count() }).from(schema.trackWorkPartV2),
    db
      .select({ value: count() })
      .from(schema.trackWorkPartV2)
      .leftJoin(
        schema.recordingTrackV2,
        eq(schema.recordingTrackV2.spotifyTrackId, schema.trackWorkPartV2.spotifyTrackId),
      )
      .where(isNull(schema.recordingTrackV2.spotifyTrackId)),
    db
      .select({ value: count() })
      .from(schema.recordingTrackV2)
      .leftJoin(
        schema.trackWorkPartV2,
        eq(schema.trackWorkPartV2.spotifyTrackId, schema.recordingTrackV2.spotifyTrackId),
      )
      .where(isNull(schema.trackWorkPartV2.spotifyTrackId)),
    db
      .select({ value: count() })
      .from(schema.trackWorkPartV2)
      .innerJoin(schema.workPartV2, eq(schema.workPartV2.id, schema.trackWorkPartV2.workPartId))
      .innerJoin(
        schema.recordingTrackV2,
        eq(schema.recordingTrackV2.spotifyTrackId, schema.trackWorkPartV2.spotifyTrackId),
      )
      .innerJoin(schema.recordingV2, eq(schema.recordingV2.id, schema.recordingTrackV2.recordingId))
      .where(ne(schema.workPartV2.workId, schema.recordingV2.workId)),
    db.select({ value: count() }).from(
      db
        .select({ workId: schema.workPartV2.workId })
        .from(schema.workPartV2)
        .groupBy(schema.workPartV2.workId, schema.workPartV2.position)
        .having(sql`count(*) > 1`)
        .as('duplicate_positions'),
    ),
    db
      .select({ value: count() })
      .from(schema.trackWorkPartV2)
      .where(eq(schema.trackWorkPartV2.matchStatus, 'needs_review')),
    db
      .select({ value: countDistinct(schema.spotifyTrack.spotifyId) })
      .from(schema.spotifyTrack)
      .leftJoin(
        schema.trackWorkPartV2,
        eq(schema.trackWorkPartV2.spotifyTrackId, schema.spotifyTrack.spotifyId),
      )
      .leftJoin(schema.matchQueue, eq(schema.matchQueue.spotifyId, schema.spotifyTrack.spotifyId))
      .where(
        and(
          isNull(schema.trackWorkPartV2.spotifyTrackId),
          or(isNull(schema.matchQueue.status), ne(schema.matchQueue.status, 'not_classical')),
        ),
      ),
  ]);

  const report = {
    storedTracks: storedTracks.value,
    linkedTracks: linkedTracks.value,
    partLinks: partLinks.value,
    tracksWithoutRecording: tracksWithoutRecording.value,
    recordingTracksWithoutParts: recordingTracksWithoutParts.value,
    crossWorkLinks: crossWorkLinks.value,
    duplicateWorkPartPositions: duplicatePositions.value,
    needsReview: needsReview.value,
    unclassifiedUnlinkedTracks: unclassifiedUnlinkedTracks.value,
  };
  console.log(report);

  if (
    report.tracksWithoutRecording > 0 ||
    report.recordingTracksWithoutParts > 0 ||
    report.crossWorkLinks > 0 ||
    report.duplicateWorkPartPositions > 0 ||
    report.unclassifiedUnlinkedTracks > 0
  ) {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
