import { loadEnvConfig } from '@next/env';

async function main() {
  const jsonOutput = process.argv.includes('--json');
  const allDetails = process.argv.includes('--details');
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
  const { normalizeMetadataText, possiblePartDuplicateKey } =
    await import('@/lib/classical-normalization');

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
    [recordingsWithoutMembers],
    [memberRecordingsWithoutPopularity],
    [recordingsWithoutMappedTracks],
    [unnamedParts],
    [composersWithoutBirthYear],
    [worksWithoutForm],
    allParts,
    allWorks,
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
    db
      .select({ value: count() })
      .from(schema.recordingV2)
      .leftJoin(
        schema.recordingTrackV2,
        eq(schema.recordingTrackV2.recordingId, schema.recordingV2.id),
      )
      .where(isNull(schema.recordingTrackV2.recordingId)),
    db
      .select({ value: countDistinct(schema.recordingV2.id) })
      .from(schema.recordingV2)
      .innerJoin(
        schema.recordingTrackV2,
        eq(schema.recordingTrackV2.recordingId, schema.recordingV2.id),
      )
      .where(isNull(schema.recordingV2.popularity)),
    db
      .select({ value: count() })
      .from(schema.recordingV2)
      .where(
        sql`NOT EXISTS (
          SELECT 1
          FROM recording_track_v2 member
          JOIN track_work_part_v2 link ON link.spotify_track_id = member.spotify_track_id
          WHERE member.recording_id = ${schema.recordingV2.id}
        )`,
      ),
    db
      .select({ value: count() })
      .from(schema.workPartV2)
      .where(
        and(
          sql`trim(coalesce(${schema.workPartV2.label}, '')) = ''`,
          sql`trim(coalesce(${schema.workPartV2.title}, '')) = ''`,
        ),
      ),
    db.select({ value: count() }).from(schema.composer).where(isNull(schema.composer.birthYear)),
    db
      .select({ value: count() })
      .from(schema.work)
      .where(sql`trim(coalesce(${schema.work.form}, '')) = ''`),
    db
      .select({
        id: schema.workPartV2.id,
        workId: schema.workPartV2.workId,
        label: schema.workPartV2.label,
        title: schema.workPartV2.title,
      })
      .from(schema.workPartV2),
    db
      .select({ id: schema.work.id, composerId: schema.work.composerId, title: schema.work.title })
      .from(schema.work),
  ]);

  const duplicatePartGroups = new Map<string, number[]>();
  for (const part of allParts) {
    const key = possiblePartDuplicateKey(part.label, part.title);
    if (!key) continue;
    const groupKey = `${part.workId}:${key}`;
    duplicatePartGroups.set(groupKey, [...(duplicatePartGroups.get(groupKey) ?? []), part.id]);
  }
  const likelyDuplicatePartGroups = [...duplicatePartGroups.entries()].filter(
    ([, ids]) => ids.length > 1,
  );

  const duplicateWorkGroups = new Map<string, number[]>();
  for (const item of allWorks) {
    const key = normalizeMetadataText(item.title);
    if (!key) continue;
    const groupKey = `${item.composerId}:${key}`;
    duplicateWorkGroups.set(groupKey, [...(duplicateWorkGroups.get(groupKey) ?? []), item.id]);
  }
  const likelyDuplicateWorkGroups = [...duplicateWorkGroups.entries()].filter(
    ([, ids]) => ids.length > 1,
  );

  const detailLimit = allDetails ? 10_000 : 5;
  const [emptyRecordingRows, unnamedPartRows, missingComposerRows, missingFormRows] =
    jsonOutput && !allDetails
      ? [[], [], [], []]
      : await Promise.all([
          db
            .select({
              recordingId: schema.recordingV2.id,
              workId: schema.recordingV2.workId,
              spotifyAlbumId: schema.recordingV2.spotifyAlbumId,
            })
            .from(schema.recordingV2)
            .where(
              sql`NOT EXISTS (
                SELECT 1 FROM recording_track_v2 member
                WHERE member.recording_id = ${schema.recordingV2.id}
              )`,
            )
            .limit(detailLimit),
          db
            .select({
              partId: schema.workPartV2.id,
              workId: schema.workPartV2.workId,
              position: schema.workPartV2.position,
            })
            .from(schema.workPartV2)
            .where(
              and(
                sql`trim(coalesce(${schema.workPartV2.label}, '')) = ''`,
                sql`trim(coalesce(${schema.workPartV2.title}, '')) = ''`,
              ),
            )
            .limit(detailLimit),
          db
            .select({ composerId: schema.composer.id, name: schema.composer.name })
            .from(schema.composer)
            .where(isNull(schema.composer.birthYear))
            .limit(detailLimit),
          db
            .select({
              workId: schema.work.id,
              composerId: schema.work.composerId,
              title: schema.work.title,
            })
            .from(schema.work)
            .where(sql`trim(coalesce(${schema.work.form}, '')) = ''`)
            .limit(detailLimit),
        ]);

  const includeDetailRows = !jsonOutput || allDetails;
  const [
    tracksWithoutRecordingRows,
    recordingTracksWithoutPartsRows,
    crossWorkLinkRows,
    duplicatePositionRows,
    unclassifiedUnlinkedTrackRows,
    memberRecordingWithoutPopularityRows,
  ] = await Promise.all([
    includeDetailRows && tracksWithoutRecording.value > 0
      ? db
          .selectDistinct({ spotifyTrackId: schema.trackWorkPartV2.spotifyTrackId })
          .from(schema.trackWorkPartV2)
          .leftJoin(
            schema.recordingTrackV2,
            eq(schema.recordingTrackV2.spotifyTrackId, schema.trackWorkPartV2.spotifyTrackId),
          )
          .where(isNull(schema.recordingTrackV2.spotifyTrackId))
          .limit(detailLimit)
      : Promise.resolve([]),
    includeDetailRows && recordingTracksWithoutParts.value > 0
      ? db
          .select({
            recordingId: schema.recordingTrackV2.recordingId,
            spotifyTrackId: schema.recordingTrackV2.spotifyTrackId,
          })
          .from(schema.recordingTrackV2)
          .leftJoin(
            schema.trackWorkPartV2,
            eq(schema.trackWorkPartV2.spotifyTrackId, schema.recordingTrackV2.spotifyTrackId),
          )
          .where(isNull(schema.trackWorkPartV2.spotifyTrackId))
          .limit(detailLimit)
      : Promise.resolve([]),
    includeDetailRows && crossWorkLinks.value > 0
      ? db
          .select({
            spotifyTrackId: schema.trackWorkPartV2.spotifyTrackId,
            partWorkId: schema.workPartV2.workId,
            recordingId: schema.recordingV2.id,
            recordingWorkId: schema.recordingV2.workId,
          })
          .from(schema.trackWorkPartV2)
          .innerJoin(schema.workPartV2, eq(schema.workPartV2.id, schema.trackWorkPartV2.workPartId))
          .innerJoin(
            schema.recordingTrackV2,
            eq(schema.recordingTrackV2.spotifyTrackId, schema.trackWorkPartV2.spotifyTrackId),
          )
          .innerJoin(
            schema.recordingV2,
            eq(schema.recordingV2.id, schema.recordingTrackV2.recordingId),
          )
          .where(ne(schema.workPartV2.workId, schema.recordingV2.workId))
          .limit(detailLimit)
      : Promise.resolve([]),
    includeDetailRows && duplicatePositions.value > 0
      ? db
          .select({
            workId: schema.workPartV2.workId,
            position: schema.workPartV2.position,
            rows: count(),
          })
          .from(schema.workPartV2)
          .groupBy(schema.workPartV2.workId, schema.workPartV2.position)
          .having(sql`count(*) > 1`)
          .limit(detailLimit)
      : Promise.resolve([]),
    includeDetailRows && unclassifiedUnlinkedTracks.value > 0
      ? db
          .selectDistinct({
            spotifyTrackId: schema.spotifyTrack.spotifyId,
            title: schema.spotifyTrack.title,
            queueStatus: schema.matchQueue.status,
          })
          .from(schema.spotifyTrack)
          .leftJoin(
            schema.trackWorkPartV2,
            eq(schema.trackWorkPartV2.spotifyTrackId, schema.spotifyTrack.spotifyId),
          )
          .leftJoin(
            schema.matchQueue,
            eq(schema.matchQueue.spotifyId, schema.spotifyTrack.spotifyId),
          )
          .where(
            and(
              isNull(schema.trackWorkPartV2.spotifyTrackId),
              or(isNull(schema.matchQueue.status), ne(schema.matchQueue.status, 'not_classical')),
            ),
          )
          .limit(detailLimit)
      : Promise.resolve([]),
    includeDetailRows && memberRecordingsWithoutPopularity.value > 0
      ? db
          .selectDistinct({
            recordingId: schema.recordingV2.id,
            workId: schema.recordingV2.workId,
            spotifyAlbumId: schema.recordingV2.spotifyAlbumId,
          })
          .from(schema.recordingV2)
          .innerJoin(
            schema.recordingTrackV2,
            eq(schema.recordingTrackV2.recordingId, schema.recordingV2.id),
          )
          .where(isNull(schema.recordingV2.popularity))
          .limit(detailLimit)
      : Promise.resolve([]),
  ]);

  const hardInvariants = {
    storedTracks: storedTracks.value,
    linkedTracks: linkedTracks.value,
    partLinks: partLinks.value,
    tracksWithoutRecording: tracksWithoutRecording.value,
    recordingTracksWithoutParts: recordingTracksWithoutParts.value,
    crossWorkLinks: crossWorkLinks.value,
    duplicateWorkPartPositions: duplicatePositions.value,
    unclassifiedUnlinkedTracks: unclassifiedUnlinkedTracks.value,
    memberRecordingsWithoutPopularity: memberRecordingsWithoutPopularity.value,
  };
  const reviewBacklog = {
    needsReviewLinks: needsReview.value,
    recordingsWithoutMembers: recordingsWithoutMembers.value,
    recordingsWithoutMappedTracks: recordingsWithoutMappedTracks.value,
    unnamedParts: unnamedParts.value,
    likelyDuplicatePartWorks: new Set(
      likelyDuplicatePartGroups.flatMap(([, ids]) =>
        allParts.filter((part) => ids.includes(part.id)).map((part) => part.workId),
      ),
    ).size,
    likelyRedundantPartRows: likelyDuplicatePartGroups.reduce(
      (sum, [, ids]) => sum + ids.length - 1,
      0,
    ),
    composersWithoutBirthYear: composersWithoutBirthYear.value,
    worksWithoutForm: worksWithoutForm.value,
    likelyDuplicateWorkGroups: likelyDuplicateWorkGroups.length,
    likelyRedundantWorkRows: likelyDuplicateWorkGroups.reduce(
      (sum, [, ids]) => sum + ids.length - 1,
      0,
    ),
  };

  const hardViolationDetails = {
    tracksWithoutRecording: tracksWithoutRecordingRows,
    recordingTracksWithoutParts: recordingTracksWithoutPartsRows,
    crossWorkLinks: crossWorkLinkRows,
    duplicateWorkPartPositions: duplicatePositionRows,
    unclassifiedUnlinkedTracks: unclassifiedUnlinkedTrackRows,
    memberRecordingsWithoutPopularity: memberRecordingWithoutPopularityRows,
  };
  const reviewDetails = {
    recordingsWithoutMembers: emptyRecordingRows,
    unnamedParts: unnamedPartRows,
    composersWithoutBirthYear: missingComposerRows,
    worksWithoutForm: missingFormRows,
    likelyDuplicatePartGroups: likelyDuplicatePartGroups
      .slice(0, detailLimit)
      .map(([key, ids]) => ({
        workId: Number(key.slice(0, key.indexOf(':'))),
        normalizedIdentity: key.slice(key.indexOf(':') + 1),
        partIds: ids,
      })),
    likelyDuplicateWorkGroups: likelyDuplicateWorkGroups
      .slice(0, detailLimit)
      .map(([key, ids]) => ({
        composerId: Number(key.slice(0, key.indexOf(':'))),
        normalizedTitle: key.slice(key.indexOf(':') + 1),
        workIds: ids,
      })),
  };
  const details = { hardViolations: hardViolationDetails, ...reviewDetails };

  const failingMetrics = new Set([
    'tracksWithoutRecording',
    'recordingTracksWithoutParts',
    'crossWorkLinks',
    'duplicateWorkPartPositions',
    'unclassifiedUnlinkedTracks',
    'memberRecordingsWithoutPopularity',
  ]);
  const hasHardFailures = [...failingMetrics].some(
    (metric) => hardInvariants[metric as keyof typeof hardInvariants] > 0,
  );

  if (jsonOutput) {
    console.log(
      JSON.stringify(
        {
          ok: !hasHardFailures,
          hardInvariants,
          reviewBacklog,
          ...(allDetails ? { details } : {}),
        },
        null,
        2,
      ),
    );
  } else {
    console.log('\nHard invariants');
    console.table(
      Object.entries(hardInvariants).map(([metric, value]) => ({
        metric,
        value,
        status: failingMetrics.has(metric) ? (value === 0 ? 'PASS' : 'FAIL') : 'INFO',
      })),
    );
    console.log('\nReview backlog (informational; never auto-fix)');
    console.table(
      Object.entries(reviewBacklog).map(([metric, value]) => ({ metric, count: value })),
    );

    const samples = allDetails ? 'Details' : 'Samples';
    for (const [name, rows] of Object.entries(hardViolationDetails)) {
      if (rows.length === 0) continue;
      console.log(`\n${samples}: hard violation — ${name}`);
      console.table(rows);
    }
    for (const [name, rows] of Object.entries(reviewDetails)) {
      if (rows.length === 0) continue;
      console.log(`\n${samples}: ${name}`);
      console.table(rows);
    }
    if (!allDetails) console.log('\nUse --details for complete affected-row lists; --json for CI.');
    console.log(
      hasHardFailures ? '\nMetadata validation FAILED.' : '\nMetadata validation passed.',
    );
  }

  if (hasHardFailures) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
