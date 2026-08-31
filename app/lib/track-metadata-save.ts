import { db } from '@/lib/db';
import {
  composer,
  recordingTrackV2,
  recordingV2,
  spotifyAlbum,
  spotifyArtist,
  spotifyTrack,
  trackArtists,
  trackWorkPartV2,
  workPartV2,
} from '@/lib/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { upsertWork } from '@/app/admin/actions/spotify-utils';
import { toRoman } from '@/lib/classical-normalization';
import { ensureWorkCatalogV2 } from '@/lib/work-parts-v2';

export interface TrackMetadataSaveInput {
  preserveExistingWork?: boolean;
  album: {
    id: string;
    name: string;
    release_date: string;
    popularity: number | null;
    images: { url: string; width: number; height: number }[];
    inSpotifyAlbumsTable: boolean;
  };
  track: {
    id: string;
    name: string;
    uri: string;
    duration_ms: number;
    disc_number: number;
    track_number: number;
    popularity: number;
    inSpotifyTracksTable: boolean;
  };
  artists: { id: string; name: string; inSpotifyArtistsTable: boolean; composerId?: number }[];
  composerArtist?: { id: string; name: string };
  metadata: {
    composerArtistId: string;
    composerName: string;
    formalName: string;
    nickname: string | null;
    catalogSystem: string | null;
    catalogNumber: string | null;
    form: string | null;
    movementNumber: number;
    movementName: string | null;
    yearComposed: number | null;
  };
}

export async function saveTrackMetadataInternal(data: TrackMetadataSaveInput) {
  const { album, track, artists, composerArtist, metadata } = data;

  const albumPromise = db
    .insert(spotifyAlbum)
    .values({
      spotifyId: album.id,
      title: album.name,
      year: album.release_date ? parseInt(album.release_date.split('-')[0]) : null,
      images: album.images,
      popularity: album.popularity || null,
    })
    .onConflictDoUpdate({
      target: spotifyAlbum.spotifyId,
      set: {
        title: album.name,
        year: album.release_date ? parseInt(album.release_date.split('-')[0]) : null,
        images: album.images,
        popularity: album.popularity || null,
      },
    });

  const artistPromises = artists.map((artist) =>
    db
      .insert(spotifyArtist)
      .values({
        spotifyId: artist.id,
        name: artist.name,
        popularity: null,
        images: null,
      })
      .onConflictDoNothing(),
  );

  if (composerArtist && !artists.some((artist) => artist.id === composerArtist.id)) {
    artistPromises.push(
      db
        .insert(spotifyArtist)
        .values({
          spotifyId: composerArtist.id,
          name: composerArtist.name,
          popularity: null,
          images: null,
        })
        .onConflictDoNothing(),
    );
  }

  await Promise.all([albumPromise, ...artistPromises]);

  let composerId = artists.find((a) => a.id === metadata.composerArtistId)?.composerId;

  if (!composerId) {
    const [existing] = await db
      .select()
      .from(composer)
      .where(eq(composer.spotifyArtistId, metadata.composerArtistId))
      .limit(1);

    if (existing) {
      composerId = existing.id;
    } else {
      const result = await db
        .insert(composer)
        .values({
          name: metadata.composerName,
          spotifyArtistId: metadata.composerArtistId,
        })
        .returning({ id: composer.id });
      composerId = result[0].id;
    }
  }

  await db
    .insert(spotifyTrack)
    .values({
      spotifyId: track.id,
      title: track.name,
      trackNumber: track.track_number,
      discNumber: track.disc_number,
      durationMs: track.duration_ms,
      popularity: track.popularity,
      spotifyAlbumId: album.id,
    })
    .onConflictDoUpdate({
      target: spotifyTrack.spotifyId,
      set: {
        title: track.name,
        trackNumber: track.track_number,
        discNumber: track.disc_number,
        durationMs: track.duration_ms,
        popularity: track.popularity,
        spotifyAlbumId: album.id,
      },
    });

  await Promise.all(
    artists.map((artist) =>
      db
        .insert(trackArtists)
        .values({
          spotifyTrackId: track.id,
          spotifyArtistId: artist.id,
        })
        .onConflictDoNothing(),
    ),
  );

  const workId = await upsertWork({
    composerId,
    title: metadata.formalName,
    nickname: metadata.nickname,
    catalogSystem: metadata.catalogSystem,
    catalogNumber: metadata.catalogNumber,
    yearComposed: metadata.yearComposed,
    form: metadata.form,
    preserveExisting: data.preserveExistingWork,
  });

  await ensureWorkCatalogV2(workId, metadata.catalogSystem, metadata.catalogNumber);
  let [part] = await db
    .select({ id: workPartV2.id })
    .from(workPartV2)
    .where(and(eq(workPartV2.workId, workId), eq(workPartV2.position, metadata.movementNumber)))
    .limit(1);
  if (!part) {
    [part] = await db
      .insert(workPartV2)
      .values({
        workId,
        position: metadata.movementNumber,
        label: toRoman(metadata.movementNumber),
        title: metadata.movementName?.trim() || null,
      })
      .returning({ id: workPartV2.id });
  }

  let [recordingRow] = await db
    .select({ id: recordingV2.id })
    .from(recordingV2)
    .where(and(eq(recordingV2.spotifyAlbumId, album.id), eq(recordingV2.workId, workId)))
    .orderBy(
      sql`(SELECT count(*) FROM recording_track_v2 WHERE recording_id = ${recordingV2.id}) DESC`,
    )
    .limit(1);
  if (!recordingRow) {
    [recordingRow] = await db
      .insert(recordingV2)
      .values({ spotifyAlbumId: album.id, workId, popularity: null })
      .returning({ id: recordingV2.id });
  }
  await db
    .insert(recordingTrackV2)
    .values({
      recordingId: recordingRow.id,
      spotifyTrackId: track.id,
    })
    .onConflictDoNothing();
  await db.delete(trackWorkPartV2).where(eq(trackWorkPartV2.spotifyTrackId, track.id));
  await db.insert(trackWorkPartV2).values({
    spotifyTrackId: track.id,
    workPartId: part.id,
    matchSource: 'manual',
    matchStatus: 'confirmed',
  });

  return {
    success: true,
    workId,
    movementId: part.id,
    recordingId: recordingRow.id,
    composerId,
  };
}
