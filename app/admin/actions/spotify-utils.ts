import type {
  SpotifyAlbumRow,
  SpotifyArtistRow,
  SpotifyTrackRow,
  ComposerRow,
  MovementRow,
  TrackMovementRow,
  WorkRow,
  RecordingRow,
} from './schema-types';
import { db, type DatabaseExecutor } from '@/lib/db';
import {
  composer,
  recordingTrackV2,
  recordingV2,
  trackWorkPartV2,
  work,
  workCatalogV2,
  workPartV2,
} from '@/lib/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { canonicalCatalogKey } from '@/lib/classical-normalization';
import { selectCanonicalWorkCandidate } from '@/lib/work-matching';

export async function upsertWork(
  data: {
    composerId: number;
    title: string;
    nickname: string | null;
    catalogSystem: string | null;
    catalogNumber: string | null;
    yearComposed: number | null;
    form: string | null;
    preserveExisting?: boolean;
  },
  database: DatabaseExecutor = db,
) {
  const {
    composerId,
    title,
    nickname,
    catalogSystem,
    catalogNumber,
    yearComposed,
    form,
    preserveExisting,
  } = data;
  let existingWork: WorkRow | undefined;

  if (catalogSystem && catalogNumber) {
    // Match on the canonical catalog identity rather than the system and number
    // separately: the same reference arrives as `Op. 34 No. 2` and `Op 34/2`,
    // and comparing the halves treats those as two different works.
    const wanted = canonicalCatalogKey(catalogSystem, catalogNumber);
    const composerWorks = await database.select().from(work).where(eq(work.composerId, composerId));
    const alsoKnownAs = await database
      .select({
        workId: workCatalogV2.workId,
        system: workCatalogV2.system,
        number: workCatalogV2.number,
      })
      .from(workCatalogV2)
      .innerJoin(work, eq(workCatalogV2.workId, work.id))
      .where(eq(work.composerId, composerId));
    const matchedByCatalogRow = new Set(
      alsoKnownAs
        .filter((row) => canonicalCatalogKey(row.system, row.number) === wanted)
        .map((row) => row.workId),
    );
    const candidates = composerWorks.filter(
      (candidate) =>
        canonicalCatalogKey(candidate.catalogSystem, candidate.catalogNumber) === wanted ||
        matchedByCatalogRow.has(candidate.id),
    );
    existingWork = selectCanonicalWorkCandidate(candidates, title) ?? undefined;
    if (!existingWork && candidates.length > 1) {
      throw new Error(
        `Ambiguous catalog identity ${wanted} for composer ${composerId}: works ` +
          `${candidates.map((candidate) => candidate.id).join(', ')}. ` +
          `Resolve with pnpm metadata:dedupe-works.`,
      );
    }
  } else {
    [existingWork] = await database
      .select()
      .from(work)
      .where(and(eq(work.composerId, composerId), eq(work.title, title)))
      .limit(1);
  }

  if (existingWork) {
    if (preserveExisting) return existingWork.id;
    await database
      .update(work)
      .set({
        title,
        nickname,
        catalogSystem,
        catalogNumber,
        yearComposed,
        form,
      })
      .where(eq(work.id, existingWork.id));
    return existingWork.id;
  }

  const [created] = await database
    .insert(work)
    .values({
      composerId,
      title,
      nickname,
      catalogSystem,
      catalogNumber,
      yearComposed,
      form,
    })
    .returning({ id: work.id });

  return created.id;
}

export async function loadTrackDbContext(spotifyTrackIds: string[]) {
  if (spotifyTrackIds.length === 0) {
    return {
      trackMovementsData: [] as TrackMovementRow[],
      movementsData: [] as MovementRow[],
      worksData: [] as WorkRow[],
      composersData: [] as ComposerRow[],
      recordingsData: [] as RecordingRow[],
    };
  }

  const trackMovementRecords = (
    await db
      .select()
      .from(trackWorkPartV2)
      .where(inArray(trackWorkPartV2.spotifyTrackId, spotifyTrackIds))
  ).map((row) => ({ ...row, movementId: row.workPartId }));

  if (trackMovementRecords.length === 0) {
    return {
      trackMovementsData: [] as TrackMovementRow[],
      movementsData: [] as MovementRow[],
      worksData: [] as WorkRow[],
      composersData: [] as ComposerRow[],
      recordingsData: [] as RecordingRow[],
    };
  }

  const movementIds = trackMovementRecords.map((tm) => tm.movementId);
  const movementsData = (
    await db.select().from(workPartV2).where(inArray(workPartV2.id, movementIds))
  ).map((row) => ({ ...row, number: row.position }));

  const workIds = movementsData.map((m) => m.workId);
  const worksData =
    workIds.length > 0 ? await db.select().from(work).where(inArray(work.id, workIds)) : [];

  const composerIds = worksData.map((w) => w.composerId);
  const composersData =
    composerIds.length > 0
      ? await db.select().from(composer).where(inArray(composer.id, composerIds))
      : [];

  const recordingsData =
    workIds.length > 0
      ? await db
          .select({
            id: recordingV2.id,
            spotifyAlbumId: recordingV2.spotifyAlbumId,
            workId: recordingV2.workId,
            popularity: recordingV2.popularity,
          })
          .from(recordingTrackV2)
          .innerJoin(recordingV2, eq(recordingTrackV2.recordingId, recordingV2.id))
          .where(inArray(recordingTrackV2.spotifyTrackId, spotifyTrackIds))
      : [];

  return {
    trackMovementsData: trackMovementRecords,
    movementsData,
    worksData,
    composersData,
    recordingsData,
  };
}

export function buildTrackMetadataDbData(params: {
  trackId: string;
  artists: Array<{ id: string }>;
  existingSpotifyArtists: SpotifyArtistRow[];
  trackMovementsData: TrackMovementRow[];
  movementsData: MovementRow[];
  worksData: WorkRow[];
  composersData: ComposerRow[];
  recordingsData: RecordingRow[];
  trackRow: SpotifyTrackRow | null;
  albumRow: SpotifyAlbumRow | null;
}) {
  const {
    trackId,
    artists,
    existingSpotifyArtists,
    trackMovementsData,
    movementsData,
    worksData,
    composersData,
    recordingsData,
    trackRow,
    albumRow,
  } = params;

  const trackMovements = trackMovementsData.filter((tm) => tm.spotifyTrackId === trackId);
  const movements = movementsData.filter((m) =>
    trackMovementsData.some((tm) => tm.movementId === m.id && tm.spotifyTrackId === trackId),
  );
  const works = worksData.filter((w) =>
    movementsData.some((m) => {
      const tm = trackMovementsData.find(
        (t) => t.movementId === m.id && t.spotifyTrackId === trackId,
      );
      return tm && m.workId === w.id;
    }),
  );
  const composers = composersData.filter((c) =>
    trackMovementsData.some((tm) => {
      const mvmt = movementsData.find((m) => m.id === tm.movementId);
      const wrk = mvmt && worksData.find((w) => w.id === mvmt.workId);
      return wrk && wrk.composerId === c.id && tm.spotifyTrackId === trackId;
    }),
  );
  const recordings = recordingsData.filter((r) =>
    worksData.some((w) => {
      const mvmt = movementsData.find((m) => m.workId === w.id);
      const tm =
        mvmt &&
        trackMovementsData.find((t) => t.movementId === mvmt.id && t.spotifyTrackId === trackId);
      return tm && r.workId === w.id;
    }),
  );

  return {
    track: trackRow,
    album: albumRow,
    artists: existingSpotifyArtists.filter((a) => artists.some((ta) => ta.id === a.spotifyId)),
    composers,
    trackMovements,
    movements,
    works,
    recordings,
  };
}
