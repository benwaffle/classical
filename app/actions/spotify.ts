'use server';

import { auth } from '@/lib/auth';
import { db } from '@/lib/db';
import {
  matchQueue,
  work,
  composer,
  spotifyArtist,
  recordingV2,
  recordingTrackV2,
  spotifyTrack,
  workPartV2,
  workCatalogV2,
  trackWorkPartV2,
} from '@/lib/db/schema';
import { headers } from 'next/headers';
import { after } from 'next/server';
import { and, inArray, eq, sql } from 'drizzle-orm';
import { enqueueAlbumsForTracks, runMatchQueueWorker } from '@/lib/match-queue-processor';

export async function getSpotifyToken(): Promise<string> {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    throw new Error('Unauthorized');
  }

  const tokenResponse = await auth.api.getAccessToken({
    body: {
      providerId: 'spotify',
      userId: session.user.id,
    },
    headers: await headers(),
  });

  if (!tokenResponse?.accessToken) {
    throw new Error('No Spotify access token');
  }

  return tokenResponse.accessToken;
}

export interface MatchedTrack {
  trackId: string;
  recordingId: number;
  discNumber: number;
  trackNumber: number;
  parts: Array<{
    id: number;
    position: number;
    label: string | null;
    title: string | null;
    matchStatus: 'confirmed' | 'needs_review';
  }>;
  work: {
    id: number;
    title: string;
    catalogSystem: string | null;
    catalogNumber: string | null;
    nickname: string | null;
    composerName: string;
  };
}

export async function getMatchedTracks(trackIds: string[]): Promise<MatchedTrack[]> {
  if (trackIds.length === 0) return [];

  const rows = await db
      .select({
        trackId: recordingTrackV2.spotifyTrackId,
        recordingId: recordingV2.id,
        discNumber: spotifyTrack.discNumber,
        trackNumber: spotifyTrack.trackNumber,
        partId: workPartV2.id,
        partPosition: workPartV2.position,
        partLabel: workPartV2.label,
        partTitle: workPartV2.title,
        matchStatus: trackWorkPartV2.matchStatus,
        workId: work.id,
        workTitle: work.title,
        catalogSystem: workCatalogV2.system,
        catalogNumber: workCatalogV2.number,
        nickname: work.nickname,
        composerName: composer.name,
      })
      .from(recordingTrackV2)
      .innerJoin(spotifyTrack, eq(recordingTrackV2.spotifyTrackId, spotifyTrack.spotifyId))
      .innerJoin(recordingV2, eq(recordingTrackV2.recordingId, recordingV2.id))
      .innerJoin(work, eq(recordingV2.workId, work.id))
      .innerJoin(composer, eq(work.composerId, composer.id))
      .innerJoin(
        trackWorkPartV2,
        eq(recordingTrackV2.spotifyTrackId, trackWorkPartV2.spotifyTrackId),
      )
      .innerJoin(workPartV2, eq(trackWorkPartV2.workPartId, workPartV2.id))
      .leftJoin(
        workCatalogV2,
        and(eq(workCatalogV2.workId, work.id), eq(workCatalogV2.isPrimary, true)),
      )
      .where(inArray(recordingTrackV2.spotifyTrackId, trackIds));

    const byTrack = new Map<string, MatchedTrack>();
    for (const row of rows) {
      const existing = byTrack.get(row.trackId);
      const part = {
        id: row.partId,
        position: row.partPosition,
        label: row.partLabel,
        title: row.partTitle,
        matchStatus: row.matchStatus,
      };
      if (existing) existing.parts.push(part);
      else {
        byTrack.set(row.trackId, {
          trackId: row.trackId,
          recordingId: row.recordingId,
          discNumber: row.discNumber,
          trackNumber: row.trackNumber,
          parts: [part],
          work: {
            id: row.workId,
            title: row.workTitle,
            catalogSystem: row.catalogSystem,
            catalogNumber: row.catalogNumber,
            nickname: row.nickname,
            composerName: row.composerName,
          },
        });
      }
    }
    for (const item of byTrack.values()) item.parts.sort((a, b) => a.position - b.position);
  return [...byTrack.values()];
}

export async function submitToMatchQueue(trackIds: string[]): Promise<{
  submitted: number;
  expanded: number;
  alreadyQueued: number;
  processingScheduled: number;
  queuedTrackIds: string[];
}> {
  if (trackIds.length === 0) {
    return {
      submitted: 0,
      expanded: 0,
      alreadyQueued: 0,
      processingScheduled: 0,
      queuedTrackIds: [],
    };
  }

  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    throw new Error('Unauthorized');
  }

  const enqueueResult = await enqueueAlbumsForTracks(trackIds, session.user.id);
  const processingScheduled = enqueueResult.submitted > 0 ? 1 : 0;

  if (processingScheduled) {
    after(async () => {
      try {
        await runMatchQueueWorker({ maxAlbums: 1 });
      } catch (error) {
        console.error('Background match-queue processing failed:', error);
      }
    });
  }

  return {
    submitted: enqueueResult.submitted,
    expanded: enqueueResult.expanded,
    alreadyQueued: enqueueResult.alreadyQueued,
    processingScheduled,
    queuedTrackIds: enqueueResult.queuedTrackIds,
  };
}

export async function getQueuedTrackIds(trackIds: string[]): Promise<string[]> {
  if (trackIds.length === 0) return [];

  const results = await db
    .select({ spotifyId: matchQueue.spotifyId })
    .from(matchQueue)
    .where(inArray(matchQueue.spotifyId, trackIds));

  return results.map((r) => r.spotifyId);
}

export async function getMatchQueue(
  limit = 50,
  offset = 0,
): Promise<{ items: { spotifyId: string; submittedAt: Date; status: string }[]; total: number }> {
  const [countResult, results] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)` })
      .from(matchQueue)
      .where(eq(matchQueue.status, 'pending')),
    db
      .select()
      .from(matchQueue)
      .where(eq(matchQueue.status, 'pending'))
      .orderBy(matchQueue.submittedAt)
      .limit(limit)
      .offset(offset),
  ]);

  return {
    items: results.map((r) => ({
      spotifyId: r.spotifyId,
      submittedAt: r.submittedAt,
      status: r.status,
    })),
    total: countResult[0]?.count ?? 0,
  };
}

export async function updateMatchQueueStatus(
  trackIds: string[],
  status: 'matched' | 'failed',
): Promise<void> {
  if (trackIds.length === 0) return;

  await db
    .update(matchQueue)
    .set({
      status,
      processedAt: new Date(),
      errorMessage: status === 'matched' ? null : undefined,
    })
    .where(inArray(matchQueue.spotifyId, trackIds));
}

export interface KnownComposerTrack {
  artistId: string;
  composerName: string;
}

export async function getKnownComposerArtists(artistIds: string[]): Promise<KnownComposerTrack[]> {
  if (artistIds.length === 0) return [];

  const results = await db
    .select({
      artistId: spotifyArtist.spotifyId,
      composerName: composer.name,
    })
    .from(composer)
    .innerJoin(spotifyArtist, eq(composer.spotifyArtistId, spotifyArtist.spotifyId))
    .where(inArray(spotifyArtist.spotifyId, artistIds));

  return results;
}
