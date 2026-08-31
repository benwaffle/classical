'use server';

import { db } from '@/lib/db';
import {
  recordingTrackV2,
  trackWorkPartV2,
  work,
  workCatalogV2,
  workPartV2,
} from '@/lib/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { checkAuth } from './auth';
import { saveTrackMetadataInternal, type TrackMetadataSaveInput } from '@/lib/track-metadata-save';

export async function saveTrackWithMetadata(data: TrackMetadataSaveInput) {
  await checkAuth();
  return saveTrackMetadataInternal(data);
}

export async function checkWorksExist(
  queries: { catalogSystem: string; catalogNumber: string }[],
): Promise<
  Record<string, { workId: number; movements: { number: number; title: string | null }[] }>
> {
  await checkAuth();

  if (queries.length === 0) return {};

  try {
    const allWorks = await db
      .select({
        id: work.id,
        catalogSystem: workCatalogV2.system,
        catalogNumber: workCatalogV2.number,
      })
      .from(work)
      .innerJoin(workCatalogV2, eq(workCatalogV2.workId, work.id))
      .where(
        inArray(
          workCatalogV2.system,
          queries.map((q) => q.catalogSystem),
        ),
      );

    const result: Record<
      string,
      { workId: number; movements: { number: number; title: string | null }[] }
    > = {};
    const matchingWorkIds: number[] = [];

    for (const w of allWorks) {
      if (!w.catalogSystem || !w.catalogNumber) continue;
      const key = `${w.catalogSystem}:${w.catalogNumber}`;
      if (
        queries.some(
          (q) => q.catalogSystem === w.catalogSystem && q.catalogNumber === w.catalogNumber,
        )
      ) {
        result[key] = { workId: w.id, movements: [] };
        matchingWorkIds.push(w.id);
      }
    }

    if (matchingWorkIds.length > 0) {
      const movements = await db
        .select({
          workId: workPartV2.workId,
          number: workPartV2.position,
          title: workPartV2.title,
        })
        .from(workPartV2)
        .where(inArray(workPartV2.workId, matchingWorkIds));

      for (const m of movements) {
        for (const value of Object.values(result)) {
          if (value.workId === m.workId) {
            value.movements.push({ number: m.number, title: m.title });
          }
        }
      }
    }

    return result;
  } catch (error) {
    console.error('Error checking works:', error);
    throw new Error('Failed to check works');
  }
}

export async function deleteTrackMetadata(spotifyTrackId: string) {
  await checkAuth();

  try {
    await db.delete(trackWorkPartV2).where(eq(trackWorkPartV2.spotifyTrackId, spotifyTrackId));
    await db.delete(recordingTrackV2).where(eq(recordingTrackV2.spotifyTrackId, spotifyTrackId));

    return {
      success: true,
      message: 'Track work-part link removed, ready for re-analysis',
    };
  } catch (error) {
    console.error('Error removing track-movement link:', error);
    throw new Error('Failed to remove track-movement link');
  }
}
