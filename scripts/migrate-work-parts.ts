import { loadEnvConfig } from '@next/env';
import migrationManifest from './work-parts-migration-manifest.json';

type Options = {
  seed: boolean;
  reparse: boolean;
  validate: boolean;
  dryRun: boolean;
  force: boolean;
  albumId?: string;
  maxAlbums: number;
};

function parseOptions(argv: string[]): Options {
  const options: Options = {
    seed: false,
    reparse: false,
    validate: false,
    dryRun: false,
    force: false,
    maxAlbums: Number.POSITIVE_INFINITY,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--seed') options.seed = true;
    else if (arg === '--reparse') options.reparse = true;
    else if (arg === '--validate') options.validate = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--album') options.albumId = argv[++index];
    else if (arg === '--max-albums') options.maxAlbums = Number(argv[++index]);
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!options.seed && !options.reparse && !options.validate) options.validate = true;
  return options;
}

async function main() {
  loadEnvConfig(process.cwd());
  const options = parseOptions(process.argv.slice(2));
  const [{ db }, schema, drizzle, normalization, parser, spotify, writer] = await Promise.all([
    import('@/lib/db'),
    import('@/lib/db/schema'),
    import('drizzle-orm'),
    import('@/lib/classical-normalization'),
    import('@/lib/classical-parser'),
    import('@/lib/spotify-app-client'),
    import('@/lib/work-parts-v2'),
  ]);
  const { and, count, countDistinct, eq, isNull, ne } = drizzle;

  async function seed() {
    const [movements, links, recordings] = await Promise.all([
      db.select().from(schema.movement),
      db.select().from(schema.trackMovement),
      db.select().from(schema.recording),
    ]);
    console.log(
      `Seed candidates: ${movements.length} parts, ${links.length} links, ${recordings.length} recordings.`,
    );
    if (options.dryRun) return;

    await writer.seedWorkCatalogV2();
    const seededParts = movements.map((item) => {
      const split = normalization.splitPartLabel(item.number, item.title);
      return {
        id: item.id,
        workId: item.workId,
        position: item.number,
        label: split.label,
        title: split.title,
      };
    });
    for (let index = 0; index < seededParts.length; index += 200) {
      await db
        .insert(schema.workPartV2)
        .values(seededParts.slice(index, index + 200))
        .onConflictDoNothing();
    }
    const movementAudits = movements.map((item) => ({
      entityType: 'movement',
      sourceId: String(item.id),
      targetId: String(item.id),
      decision: 'seeded',
      reason: 'Mechanical fallback assignment',
    }));
    for (let index = 0; index < movementAudits.length; index += 200) {
      await db
        .insert(schema.metadataMigrationAudit)
        .values(movementAudits.slice(index, index + 200))
        .onConflictDoNothing();
    }
    for (let index = 0; index < links.length; index += 200) {
      await db
        .insert(schema.trackWorkPartV2)
        .values(
          links.slice(index, index + 200).map((link) => ({
            spotifyTrackId: link.spotifyTrackId,
            workPartId: link.movementId,
            startMs: link.startMs,
            endMs: link.endMs,
            matchSource: 'migrated' as const,
            matchStatus: 'needs_review' as const,
          })),
        )
        .onConflictDoNothing();
    }

    const catalogRows = await db
      .select({
        workId: schema.work.id,
        composerId: schema.work.composerId,
        title: schema.work.title,
        normalizedSystem: schema.workCatalogV2.normalizedSystem,
        normalizedNumber: schema.workCatalogV2.normalizedNumber,
      })
      .from(schema.workCatalogV2)
      .innerJoin(schema.work, eq(schema.workCatalogV2.workId, schema.work.id));
    const catalogGroups = new Map<string, typeof catalogRows>();
    for (const row of catalogRows) {
      const key = `${row.composerId}:${row.normalizedSystem}:${row.normalizedNumber}`;
      catalogGroups.set(key, [...(catalogGroups.get(key) ?? []), row]);
    }
    for (const rows of catalogGroups.values()) {
      if (rows.length < 2) continue;
      const titleGroups = new Map<string, typeof rows>();
      for (const row of rows) {
        const key = normalization.normalizeMetadataText(row.title);
        titleGroups.set(key, [...(titleGroups.get(key) ?? []), row]);
      }
      for (const sameTitle of titleGroups.values()) {
        const canonicalId = Math.min(...sameTitle.map((row) => row.workId));
        for (const row of sameTitle) {
          await db
            .insert(schema.metadataMigrationAudit)
            .values({
              entityType: 'work',
              sourceId: String(row.workId),
              targetId: String(canonicalId),
              decision: row.workId === canonicalId ? 'canonical' : 'merge',
              reason: 'Equal composer, normalized catalog, and normalized title',
            })
            .onConflictDoNothing();
        }
      }
      for (const row of rows) {
        await db
          .insert(schema.metadataMigrationAudit)
          .values({
            entityType: 'work',
            sourceId: String(row.workId),
            targetId: String(row.workId),
            decision: 'keep_separate',
            reason: 'Shared catalog with a differing title; conservative fallback',
          })
          .onConflictDoNothing();
      }
    }
    for (const [sourceId, decision] of Object.entries(migrationManifest.workDecisions)) {
      const targetId = typeof decision === 'number' ? String(decision) : sourceId;
      await db
        .insert(schema.metadataMigrationAudit)
        .values({
          entityType: 'work',
          sourceId,
          targetId,
          decision: typeof decision === 'number' ? 'merge' : 'keep_separate',
          reason: `Explicit migration manifest v${migrationManifest.version}`,
        })
        .onConflictDoUpdate({
          target: [
            schema.metadataMigrationAudit.entityType,
            schema.metadataMigrationAudit.sourceId,
          ],
          set: {
            targetId,
            decision: typeof decision === 'number' ? 'merge' : 'keep_separate',
            reason: `Explicit migration manifest v${migrationManifest.version}`,
          },
        });
    }
    for (let index = 0; index < recordings.length; index += 200) {
      await db
        .insert(schema.recordingV2)
        .values(
          recordings.slice(index, index + 200).map((item) => ({
            id: item.id,
            spotifyAlbumId: item.spotifyAlbumId,
            workId: item.workId,
            popularity: item.popularity,
          })),
        )
        .onConflictDoNothing();
    }

    const memberships = await db
      .select({
        recordingId: schema.recording.id,
        spotifyTrackId: schema.spotifyTrack.spotifyId,
        discNumber: schema.spotifyTrack.discNumber,
        trackNumber: schema.spotifyTrack.trackNumber,
      })
      .from(schema.spotifyTrack)
      .innerJoin(
        schema.trackMovement,
        eq(schema.trackMovement.spotifyTrackId, schema.spotifyTrack.spotifyId),
      )
      .innerJoin(schema.movement, eq(schema.movement.id, schema.trackMovement.movementId))
      .innerJoin(
        schema.recording,
        and(
          eq(schema.recording.spotifyAlbumId, schema.spotifyTrack.spotifyAlbumId),
          eq(schema.recording.workId, schema.movement.workId),
        ),
      );
    const byRecording = new Map<number, typeof memberships>();
    for (const membership of memberships) {
      const rows = byRecording.get(membership.recordingId) ?? [];
      if (!rows.some((row) => row.spotifyTrackId === membership.spotifyTrackId)) {
        rows.push(membership);
      }
      byRecording.set(membership.recordingId, rows);
    }
    const recordingMemberships = [];
    for (const [recordingId, rows] of byRecording) {
      rows.sort((a, b) => a.discNumber - b.discNumber || a.trackNumber - b.trackNumber);
      for (let position = 0; position < rows.length; position++) {
        recordingMemberships.push({
          recordingId,
          spotifyTrackId: rows[position].spotifyTrackId,
          position: position + 1,
        });
      }
    }
    for (let index = 0; index < recordingMemberships.length; index += 200) {
      await db
        .insert(schema.recordingTrackV2)
        .values(recordingMemberships.slice(index, index + 200))
        .onConflictDoNothing();
    }
  }

  async function reparse() {
    const albums = options.albumId
      ? [{ id: options.albumId }]
      : await db
          .selectDistinct({ id: schema.spotifyTrack.spotifyAlbumId })
          .from(schema.spotifyTrack);
    const selectedAlbums = albums.slice(0, options.maxAlbums);
    const concurrency = Number(process.env.METADATA_MIGRATION_CONCURRENCY ?? 4);
    let cursor = 0;
    const processNext = async () => {
      const index = cursor++;
      if (index >= selectedAlbums.length) return;
      const { id } = selectedAlbums[index];
      const [audit] = await db
        .select()
        .from(schema.metadataMigrationAudit)
        .where(
          and(
            eq(schema.metadataMigrationAudit.entityType, 'album'),
            eq(schema.metadataMigrationAudit.sourceId, id),
          ),
        )
        .limit(1);
      if (audit?.decision === 'reparsed' && !options.force) return processNext();

      const { album, tracks } = await spotify.getSpotifyAlbumTracks(id);
      const ordered = [...tracks].sort(
        (a, b) => a.disc_number - b.disc_number || a.track_number - b.track_number,
      );
      const storedTracks = await db
        .select({ id: schema.spotifyTrack.spotifyId })
        .from(schema.spotifyTrack)
        .where(eq(schema.spotifyTrack.spotifyAlbumId, id));
      const storedTrackIds = new Set(storedTracks.map((track) => track.id));
      console.log(
        `[${index + 1}/${selectedAlbums.length}] ${album.name} (${ordered.length})`,
      );
      if (options.dryRun) {
        return processNext();
      }
      for (const track of ordered.filter((track) => storedTrackIds.has(track.id))) {
        await db
          .update(schema.spotifyTrack)
          .set({ discNumber: track.disc_number, trackNumber: track.track_number })
          .where(eq(schema.spotifyTrack.spotifyId, track.id));
      }
      const parsed = await parser.parseAlbumTracksV2(
        album.name,
        ordered.map((track) => ({
          trackName: track.name,
          artistNames: track.artists.map((artist) => artist.name),
          discNumber: track.disc_number,
          trackNumber: track.track_number,
        })),
      );
      const storedParsedTracks = ordered
        .map((track, index) => ({ track, metadata: parsed[index] }))
        .filter(({ track }) => storedTrackIds.has(track.id));
      const result = await writer.saveParsedAlbumV2(
        id,
        storedParsedTracks.map(({ track }) => ({
          id: track.id,
          discNumber: track.disc_number,
          trackNumber: track.track_number,
        })),
        storedParsedTracks.map(({ metadata }) => metadata),
      );
      await db
        .insert(schema.metadataMigrationAudit)
        .values({
          entityType: 'album',
          sourceId: id,
          targetId: id,
          decision: 'reparsed',
          reason: JSON.stringify(result),
        })
        .onConflictDoUpdate({
          target: [
            schema.metadataMigrationAudit.entityType,
            schema.metadataMigrationAudit.sourceId,
          ],
          set: { decision: 'reparsed', reason: JSON.stringify(result) },
        });
      return processNext();
    };
    await Promise.all(
      Array.from({ length: Math.min(concurrency, selectedAlbums.length) }, () => processNext()),
    );
  }

  async function validate() {
    const [
      [newCoverage],
      [storedTracks],
      [candidateTracks],
      [unassigned],
      [crossWork],
      [reviews],
      [completed],
      [totalAlbums],
    ] = await Promise.all([
      db.select({ value: count() }).from(schema.trackWorkPartV2),
      db.select({ value: count() }).from(schema.spotifyTrack),
      db
        .select({ value: countDistinct(schema.trackWorkPartV2.spotifyTrackId) })
        .from(schema.trackWorkPartV2),
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
        .where(ne(schema.workPartV2.workId, schema.recordingV2.workId)),
      db
        .select({ value: count() })
        .from(schema.trackWorkPartV2)
        .where(eq(schema.trackWorkPartV2.matchStatus, 'needs_review')),
      db
        .select({ value: count() })
        .from(schema.metadataMigrationAudit)
        .where(
          and(
            eq(schema.metadataMigrationAudit.entityType, 'album'),
            eq(schema.metadataMigrationAudit.decision, 'reparsed'),
          ),
        ),
      db
        .select({ value: count() })
        .from(
          db
            .selectDistinct({ id: schema.spotifyTrack.spotifyAlbumId })
            .from(schema.spotifyTrack)
            .as('all_albums'),
        ),
    ]);
    const report = {
      storedTracks: storedTracks.value,
      candidateTracks: candidateTracks.value,
      candidateLinks: newCoverage.value,
      candidateTracksWithoutRecording: unassigned.value,
      crossWorkLinks: crossWork.value,
      needsReview: reviews.value,
      albumsReparsed: completed.value,
      totalAlbums: totalAlbums.value,
    };
    console.log(report);
    if (
      report.candidateTracks !== report.storedTracks ||
      report.candidateTracksWithoutRecording > 0 ||
      report.crossWorkLinks > 0
    ) {
      process.exitCode = 2;
    }
  }

  if (options.seed) await seed();
  if (options.reparse) await reparse();
  if (options.validate) await validate();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
