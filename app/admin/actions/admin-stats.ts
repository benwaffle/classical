'use server';

import { db } from '@/lib/db';
import { composer, spotifyArtist, spotifyTrack, trackWorkPartV2, work } from '@/lib/db/schema';
import { count, eq, isNull } from 'drizzle-orm';
import { checkAuth } from './auth';

export async function getAdminStats(): Promise<{
  pendingTracks: number;
  unlinkedArtists: number;
  totalWorks: number;
}> {
  await checkAuth();

  const [pendingTracksResult] = await db
    .select({ count: count() })
    .from(spotifyTrack)
    .leftJoin(trackWorkPartV2, eq(spotifyTrack.spotifyId, trackWorkPartV2.spotifyTrackId))
    .where(isNull(trackWorkPartV2.workPartId));

  const [unlinkedArtistsResult] = await db
    .select({ count: count() })
    .from(spotifyArtist)
    .leftJoin(composer, eq(spotifyArtist.spotifyId, composer.spotifyArtistId))
    .where(isNull(composer.id));

  const [totalWorksResult] = await db.select({ count: count() }).from(work);

  return {
    pendingTracks: pendingTracksResult.count,
    unlinkedArtists: unlinkedArtistsResult.count,
    totalWorks: totalWorksResult.count,
  };
}
