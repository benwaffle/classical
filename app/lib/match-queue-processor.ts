import { db } from '@/lib/db';
import { composer, matchQueue, trackMovement } from '@/lib/db/schema';
import {
  getSpotifyAlbumMetadata,
  getSpotifyAlbumTrackIds,
  getSpotifyAlbumTracks,
  getSpotifyTracksByIds,
  findSpotifyArtistByName,
  type SpotifyArtistMetadata,
} from '@/lib/spotify-app-client';
import { parseAlbumTracks, type ClassicalMetadata } from '@/lib/classical-parser';
import { saveTrackMetadataInternal } from '@/lib/track-metadata-save';
import { and, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import type { Track } from '@spotify/web-api-ts-sdk';

export type MatchQueueStatus = 'pending' | 'processing' | 'matched' | 'failed' | 'not_classical';

export interface EnqueueResult {
  submitted: number;
  expanded: number;
  alreadyQueued: number;
  albumIds: string[];
  queuedTrackIds: string[];
}

export interface AlbumProcessResult {
  albumId: string;
  claimed: number;
  matched: number;
  failed: number;
  notClassical: number;
  errors: Array<{ trackId?: string; message: string; retryable?: boolean }>;
}

export interface ClaimedAlbum {
  albumId: string;
  trackIds: string[];
}

let metadataSaveTail = Promise.resolve();

async function withMetadataSaveLock<T>(action: () => Promise<T>) {
  const previous = metadataSaveTail;
  let release!: () => void;
  metadataSaveTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await action();
  } finally {
    release();
  }
}

function now() {
  return new Date();
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function isRetryableProcessingError(message: string) {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('429') ||
    normalized.includes('408') ||
    normalized.includes('409') ||
    normalized.includes('500') ||
    normalized.includes('502') ||
    normalized.includes('503') ||
    normalized.includes('504') ||
    normalized.includes('rate limit') ||
    normalized.includes('rate-limit') ||
    normalized.includes('rate limits') ||
    normalized.includes('too many requests') ||
    normalized.includes('timeout') ||
    normalized.includes('timed out') ||
    normalized.includes('fetch failed') ||
    normalized.includes('econnreset') ||
    normalized.includes('socket hang up') ||
    normalized.includes('temporarily unavailable') ||
    normalized.includes('overloaded')
  );
}

function compareTrackOrder(a: Track, b: Track) {
  return a.disc_number - b.disc_number || a.track_number - b.track_number;
}

function normalizeArtistName(name: string) {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/\p{Pd}/gu, '-')
    .trim()
    .toLowerCase();
}

function metadataWorkKey(metadata: ClassicalMetadata) {
  return [
    metadata.composerName?.trim().toLowerCase() ?? '',
    metadata.catalogSystem?.trim().toLowerCase() ?? '',
    metadata.catalogNumber?.trim().toLowerCase() ?? '',
    metadata.formalName.trim().toLowerCase(),
  ].join('|');
}

function getMovementNumber(
  track: Track,
  metadata: ClassicalMetadata,
  parsedByTrackId: Map<string, ClassicalMetadata>,
  tracks: Track[],
) {
  if (metadata.movement) return metadata.movement;

  const key = metadataWorkKey(metadata);
  const sameWorkTracks = tracks
    .filter((candidate) => {
      const candidateMetadata = parsedByTrackId.get(candidate.id);
      return candidateMetadata && metadataWorkKey(candidateMetadata) === key;
    })
    .sort(compareTrackOrder);

  if (sameWorkTracks.length <= 1) return 1;

  const position = sameWorkTracks.findIndex((candidate) => candidate.id === track.id);
  return position >= 0 ? position + 1 : 1;
}

async function setQueueStatus(
  trackIds: string[],
  status: MatchQueueStatus,
  data: { claimOwnerId?: string | null; errorMessage?: string | null } = {},
) {
  if (trackIds.length === 0) return;

  await db
    .update(matchQueue)
    .set({
      status,
      processedAt: status === 'processing' || status === 'pending' ? null : now(),
      errorMessage: data.errorMessage ?? null,
      claimOwnerId: data.claimOwnerId ?? undefined,
    })
    .where(
      and(
        inArray(matchQueue.spotifyId, trackIds),
        data.claimOwnerId ? eq(matchQueue.claimOwnerId, data.claimOwnerId) : undefined,
      ),
    );
}

async function enqueueAlbumTracks(albumId: string, submittedBy: string) {
  const [album, albumTrackIds] = await Promise.all([
    getSpotifyAlbumMetadata(albumId),
    getSpotifyAlbumTrackIds(albumId),
  ]);

  if (albumTrackIds.length === 0) {
    return { albumId, trackIds: [] as string[], submitted: 0, alreadyQueued: 0 };
  }

  const existingRows = await db
    .select({
      spotifyId: matchQueue.spotifyId,
      status: matchQueue.status,
      spotifyAlbumId: matchQueue.spotifyAlbumId,
    })
    .from(matchQueue)
    .where(inArray(matchQueue.spotifyId, albumTrackIds));

  const existingById = new Map(existingRows.map((row) => [row.spotifyId, row]));
  const newTrackIds = albumTrackIds.filter((trackId) => !existingById.has(trackId));
  const retryTrackIds = existingRows
    .filter((row) => row.status === 'not_classical')
    .map((row) => row.spotifyId);
  const missingAlbumIds = existingRows
    .filter((row) => row.spotifyAlbumId !== album.id)
    .map((row) => row.spotifyId);

  if (newTrackIds.length > 0) {
    await db.insert(matchQueue).values(
      newTrackIds.map((trackId) => ({
        spotifyId: trackId,
        spotifyAlbumId: album.id,
        submittedBy,
        status: 'pending',
      })),
    );
  }

  if (retryTrackIds.length > 0) {
    await db
      .update(matchQueue)
      .set({
        spotifyAlbumId: album.id,
        status: 'pending',
        processedAt: null,
        errorMessage: null,
      })
      .where(inArray(matchQueue.spotifyId, retryTrackIds));
  }

  if (missingAlbumIds.length > 0) {
    await db
      .update(matchQueue)
      .set({ spotifyAlbumId: album.id })
      .where(inArray(matchQueue.spotifyId, missingAlbumIds));
  }

  return {
    albumId,
    trackIds: albumTrackIds,
    submitted: newTrackIds.length + retryTrackIds.length,
    alreadyQueued: albumTrackIds.length - newTrackIds.length - retryTrackIds.length,
  };
}

export async function enqueueAlbumsForTracks(
  trackIds: string[],
  submittedBy: string,
): Promise<EnqueueResult> {
  if (trackIds.length === 0) {
    return { submitted: 0, expanded: 0, alreadyQueued: 0, albumIds: [], queuedTrackIds: [] };
  }

  const tracks = await getSpotifyTracksByIds([...new Set(trackIds)]);
  const albumIds = [...new Set(tracks.map((track) => track.album.id))];

  let submitted = 0;
  let alreadyQueued = 0;
  const queuedTrackIds = new Set<string>();

  for (const albumId of albumIds) {
    const result = await enqueueAlbumTracks(albumId, submittedBy);
    submitted += result.submitted;
    alreadyQueued += result.alreadyQueued;
    result.trackIds.forEach((trackId) => queuedTrackIds.add(trackId));
  }

  return {
    submitted,
    expanded: queuedTrackIds.size,
    alreadyQueued,
    albumIds,
    queuedTrackIds: [...queuedTrackIds],
  };
}

async function hydratePendingRowsWithoutAlbumIds(limit = 50) {
  const rows = await db
    .select({ spotifyId: matchQueue.spotifyId, submittedBy: matchQueue.submittedBy })
    .from(matchQueue)
    .where(and(eq(matchQueue.status, 'pending'), isNull(matchQueue.spotifyAlbumId)))
    .limit(limit);

  if (rows.length === 0) return 0;

  const tracks = await getSpotifyTracksByIds(rows.map((row) => row.spotifyId));
  const trackById = new Map(tracks.map((track) => [track.id, track]));
  const submitterByAlbumId = new Map<string, string>();

  for (const row of rows) {
    const track = trackById.get(row.spotifyId);
    if (!track) {
      await setQueueStatus([row.spotifyId], 'failed', {
        errorMessage: 'Spotify track was not found',
      });
      continue;
    }

    submitterByAlbumId.set(
      track.album.id,
      submitterByAlbumId.get(track.album.id) ?? row.submittedBy,
    );
    await db
      .update(matchQueue)
      .set({ spotifyAlbumId: track.album.id })
      .where(eq(matchQueue.spotifyId, row.spotifyId));
  }

  for (const [albumId, submittedBy] of submitterByAlbumId) {
    await enqueueAlbumTracks(albumId, submittedBy);
  }

  return submitterByAlbumId.size;
}

async function getNextPendingAlbumId(maxAttempts?: number) {
  const [row] = await db
    .select({ spotifyAlbumId: matchQueue.spotifyAlbumId })
    .from(matchQueue)
    .where(
      and(
        eq(matchQueue.status, 'pending'),
        isNotNull(matchQueue.spotifyAlbumId),
        maxAttempts === undefined ? undefined : lt(matchQueue.attempts, maxAttempts),
      ),
    )
    .groupBy(matchQueue.spotifyAlbumId)
    .limit(1);

  if (row?.spotifyAlbumId) return row.spotifyAlbumId;

  const hydrated = await hydratePendingRowsWithoutAlbumIds();
  if (hydrated === 0) return null;

  const [hydratedRow] = await db
    .select({ spotifyAlbumId: matchQueue.spotifyAlbumId })
    .from(matchQueue)
    .where(
      and(
        eq(matchQueue.status, 'pending'),
        isNotNull(matchQueue.spotifyAlbumId),
        maxAttempts === undefined ? undefined : lt(matchQueue.attempts, maxAttempts),
      ),
    )
    .groupBy(matchQueue.spotifyAlbumId)
    .limit(1);

  return hydratedRow?.spotifyAlbumId ?? null;
}

export async function claimNextPendingAlbum(
  claimOwnerId?: string,
  maxAttempts?: number,
): Promise<ClaimedAlbum | null> {
  for (let collisionRetry = 0; collisionRetry < 10; collisionRetry++) {
    const albumId = await getNextPendingAlbumId(maxAttempts);
    if (!albumId) return null;

    const claim = await claimPendingAlbum(albumId, claimOwnerId, maxAttempts);
    if (claim) return claim;
  }

  return null;
}

export async function claimPendingAlbum(
  albumId: string,
  claimOwnerId?: string,
  maxAttempts?: number,
): Promise<ClaimedAlbum | null> {
  await db
    .update(matchQueue)
    .set({
      status: 'processing',
      attempts: sql`${matchQueue.attempts} + 1`,
      lastAttemptAt: now(),
      errorMessage: null,
      claimOwnerId,
    })
    .where(
      and(
        eq(matchQueue.spotifyAlbumId, albumId),
        eq(matchQueue.status, 'pending'),
        maxAttempts === undefined ? undefined : lt(matchQueue.attempts, maxAttempts),
      ),
    );

  const rows = await db
    .select({ spotifyId: matchQueue.spotifyId })
    .from(matchQueue)
    .where(
      and(
        eq(matchQueue.spotifyAlbumId, albumId),
        eq(matchQueue.status, 'processing'),
        claimOwnerId ? eq(matchQueue.claimOwnerId, claimOwnerId) : undefined,
      ),
    );

  if (rows.length === 0) return null;

  return {
    albumId,
    trackIds: rows.map((row) => row.spotifyId),
  };
}

async function getProcessingTrackIds(albumId: string, claimOwnerId?: string) {
  const rows = await db
    .select({ spotifyId: matchQueue.spotifyId })
    .from(matchQueue)
    .where(
      and(
        eq(matchQueue.spotifyAlbumId, albumId),
        eq(matchQueue.status, 'processing'),
        claimOwnerId ? eq(matchQueue.claimOwnerId, claimOwnerId) : undefined,
      ),
    );

  return rows.map((row) => row.spotifyId);
}

async function getLinkedTrackIds(trackIds: string[]) {
  if (trackIds.length === 0) return new Set<string>();

  const linkedRows = await db
    .select({ spotifyTrackId: trackMovement.spotifyTrackId })
    .from(trackMovement)
    .where(inArray(trackMovement.spotifyTrackId, trackIds));

  return new Set(linkedRows.map((row) => row.spotifyTrackId));
}

async function saveParsedTrack(
  album: Awaited<ReturnType<typeof getSpotifyAlbumTracks>>['album'],
  track: Track,
  metadata: ClassicalMetadata,
  movementNumber: number,
) {
  const composerName = metadata.composerName?.trim();
  const formalName = metadata.formalName.trim();

  if (!metadata.isClassical) return 'not_classical' as const;
  if (!composerName || !formalName) {
    throw new Error('Parsed metadata is missing composer or work title');
  }

  const creditedComposerArtist = track.artists.find(
    (artist) => normalizeArtistName(artist.name) === normalizeArtistName(composerName),
  );
  let composerArtist: SpotifyArtistMetadata | undefined = creditedComposerArtist
    ? { id: creditedComposerArtist.id, name: creditedComposerArtist.name }
    : undefined;

  if (!composerArtist) {
    const [existingComposer] = await db
      .select({ spotifyArtistId: composer.spotifyArtistId })
      .from(composer)
      .where(sql`lower(trim(${composer.name})) = ${composerName.toLowerCase()}`)
      .limit(1);

    if (existingComposer?.spotifyArtistId) {
      composerArtist = { id: existingComposer.spotifyArtistId, name: composerName };
    } else {
      const surname = composerName
        .trim()
        .split(/\s+/)
        .at(-1)
        ?.replace(/[^\p{L}\p{N}-]/gu, '')
        .toLowerCase();
      const surnameMatches = surname
        ? await db
            .select({ name: composer.name, spotifyArtistId: composer.spotifyArtistId })
            .from(composer)
            .where(sql`lower(${composer.name}) like ${`%${surname}%`}`)
            .limit(2)
        : [];
      const uniqueSurnameMatch =
        surnameMatches.length === 1 && surnameMatches[0].spotifyArtistId
          ? surnameMatches[0]
          : undefined;

      composerArtist = uniqueSurnameMatch
        ? { id: uniqueSurnameMatch.spotifyArtistId!, name: uniqueSurnameMatch.name }
        : ((await findSpotifyArtistByName(composerName)) ?? undefined);
    }
  }

  if (!composerArtist) {
    throw new Error(`Could not resolve Spotify artist for composer "${composerName}"`);
  }

  await saveTrackMetadataInternal({
    album: {
      id: album.id,
      name: album.name,
      release_date: album.release_date,
      popularity: album.popularity,
      images: album.images,
      inSpotifyAlbumsTable: false,
    },
    track: {
      id: track.id,
      name: track.name,
      uri: track.uri,
      duration_ms: track.duration_ms,
      track_number: track.track_number,
      popularity: track.popularity,
      inSpotifyTracksTable: false,
    },
    artists: track.artists.map((artist) => ({
      id: artist.id,
      name: artist.name,
      inSpotifyArtistsTable: false,
    })),
    composerArtist: {
      id: composerArtist.id,
      name: composerArtist.name,
    },
    metadata: {
      composerArtistId: composerArtist.id,
      composerName,
      formalName,
      nickname: metadata.nickname || null,
      catalogSystem: metadata.catalogSystem || null,
      catalogNumber: metadata.catalogNumber || null,
      form: metadata.form || null,
      movementNumber,
      movementName: metadata.movementName || null,
      yearComposed: metadata.yearComposed || null,
    },
  });

  return 'matched' as const;
}

export async function processQueuedAlbum(
  albumId: string,
  claimOwnerId?: string,
  claimedTrackIds?: string[],
): Promise<AlbumProcessResult> {
  let trackIdsToProcess = claimedTrackIds;

  if (!trackIdsToProcess) {
    await db
      .update(matchQueue)
      .set({
        status: 'processing',
        attempts: sql`${matchQueue.attempts} + 1`,
        lastAttemptAt: now(),
        errorMessage: null,
        claimOwnerId,
      })
      .where(and(eq(matchQueue.spotifyAlbumId, albumId), eq(matchQueue.status, 'pending')));

    trackIdsToProcess = await getProcessingTrackIds(albumId, claimOwnerId);
  } else if (claimOwnerId) {
    await db
      .update(matchQueue)
      .set({ claimOwnerId })
      .where(inArray(matchQueue.spotifyId, trackIdsToProcess));
  }

  const trackIds = trackIdsToProcess;
  const result: AlbumProcessResult = {
    albumId,
    claimed: trackIds.length,
    matched: 0,
    failed: 0,
    notClassical: 0,
    errors: [],
  };

  if (trackIds.length === 0) return result;

  try {
    const { album, tracks } = await getSpotifyAlbumTracks(albumId);
    const albumTracks = tracks.sort(compareTrackOrder);
    const albumTrackById = new Map(albumTracks.map((track) => [track.id, track]));
    const missingTrackIds = trackIds.filter((trackId) => !albumTrackById.has(trackId));

    if (missingTrackIds.length > 0) {
      await setQueueStatus(missingTrackIds, 'failed', {
        claimOwnerId,
        errorMessage: 'Queued track was not found on its Spotify album',
      });
      result.errors.push(
        ...missingTrackIds.map((trackId) => ({
          trackId,
          message: 'Queued track was not found on its Spotify album',
        })),
      );
      result.failed += missingTrackIds.length;
    }

    const processableTrackIds = trackIds.filter((trackId) => albumTrackById.has(trackId));
    const linkedTrackIds = await getLinkedTrackIds(processableTrackIds);
    const alreadyLinkedTrackIds = processableTrackIds.filter((trackId) =>
      linkedTrackIds.has(trackId),
    );

    if (alreadyLinkedTrackIds.length > 0) {
      await setQueueStatus(alreadyLinkedTrackIds, 'matched', { claimOwnerId });
      result.matched += alreadyLinkedTrackIds.length;
    }

    const unknownTracks = processableTrackIds
      .filter((trackId) => !linkedTrackIds.has(trackId))
      .map((trackId) => albumTrackById.get(trackId)!)
      .sort(compareTrackOrder);

    if (unknownTracks.length === 0) return result;

    const parsed = await parseAlbumTracks(
      album.name,
      unknownTracks.map((track) => ({
        trackName: track.name,
        artistNames: track.artists.map((artist) => artist.name),
      })),
    );
    const parsedByTrackId = new Map(unknownTracks.map((track, index) => [track.id, parsed[index]]));

    await withMetadataSaveLock(async () => {
      for (const track of unknownTracks) {
        const metadata = parsedByTrackId.get(track.id);
        if (!metadata) {
          await setQueueStatus([track.id], 'failed', {
            claimOwnerId,
            errorMessage: 'No parsed metadata returned for track',
          });
          result.errors.push({
            trackId: track.id,
            message: 'No parsed metadata returned for track',
          });
          result.failed++;
          continue;
        }

        try {
          const movementNumber = getMovementNumber(track, metadata, parsedByTrackId, unknownTracks);
          const status = await saveParsedTrack(album, track, metadata, movementNumber);
          await setQueueStatus([track.id], status, { claimOwnerId });

          if (status === 'matched') result.matched++;
          if (status === 'not_classical') result.notClassical++;
        } catch (error) {
          const message = errorMessage(error, 'Failed to save parsed metadata');
          const status = isRetryableProcessingError(message) ? 'pending' : 'failed';
          await setQueueStatus([track.id], status, {
            claimOwnerId,
            errorMessage: message,
          });
          result.errors.push({ trackId: track.id, message, retryable: status === 'pending' });
          if (status === 'failed') result.failed++;
        }
      }
    });

    return result;
  } catch (error) {
    const message = errorMessage(error, 'Failed to process album');
    const status = isRetryableProcessingError(message) ? 'pending' : 'failed';
    const activeTrackIds = await getProcessingTrackIds(albumId, claimOwnerId);

    await setQueueStatus(activeTrackIds, status, {
      claimOwnerId,
      errorMessage: message,
    });
    result.errors.push({ message, retryable: status === 'pending' });
    if (status === 'failed') result.failed += activeTrackIds.length;
    return result;
  }
}
