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
import { db } from '@/lib/db';
import {
  composer,
  recordingTrackV2,
  recordingV2,
  trackWorkPartV2,
  work,
  workPartV2,
} from '@/lib/db/schema';
import { and, eq, inArray } from 'drizzle-orm';

export async function upsertWork(data: {
  composerId: number;
  title: string;
  nickname: string | null;
  catalogSystem: string | null;
  catalogNumber: string | null;
  yearComposed: number | null;
  form: string | null;
  preserveExisting?: boolean;
}) {
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
    [existingWork] = await db
      .select()
      .from(work)
      .where(
        and(
          eq(work.composerId, composerId),
          eq(work.catalogSystem, catalogSystem),
          eq(work.catalogNumber, catalogNumber),
        ),
      )
      .limit(1);
  } else {
    [existingWork] = await db
      .select()
      .from(work)
      .where(and(eq(work.composerId, composerId), eq(work.title, title)))
      .limit(1);
  }

  if (existingWork) {
    if (preserveExisting) return existingWork.id;
    await db
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

  const [created] = await db
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
