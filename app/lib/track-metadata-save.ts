import { db } from '@/lib/db';
import { composer, spotifyAlbum, spotifyArtist, spotifyTrack, trackArtists } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import {
  linkTrackMovement,
  upsertMovement,
  upsertRecording,
  upsertWork,
} from '@/app/admin/actions/spotify-utils';

export interface TrackMetadataSaveInput {
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
      durationMs: track.duration_ms,
      popularity: track.popularity,
      spotifyAlbumId: album.id,
    })
    .onConflictDoUpdate({
      target: spotifyTrack.spotifyId,
      set: {
        title: track.name,
        trackNumber: track.track_number,
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
  });

  const movementId = await upsertMovement({
    workId,
    number: metadata.movementNumber,
    title: metadata.movementName,
  });

  const recordingId = await upsertRecording({
    spotifyAlbumId: album.id,
    workId,
  });

  await linkTrackMovement({
    spotifyTrackId: track.id,
    movementId,
  });

  return { success: true, workId, movementId, recordingId, composerId };
}
