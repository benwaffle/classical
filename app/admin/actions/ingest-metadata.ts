'use server';

import { db } from '@/lib/db';
import { trackMovement, work, movement } from '@/lib/db/schema';
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
        catalogSystem: work.catalogSystem,
        catalogNumber: work.catalogNumber,
      })
      .from(work)
      .where(
        inArray(
          work.catalogSystem,
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
          workId: movement.workId,
          number: movement.number,
          title: movement.title,
        })
        .from(movement)
        .where(inArray(movement.workId, matchingWorkIds));

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
    await db.delete(trackMovement).where(eq(trackMovement.spotifyTrackId, spotifyTrackId));

    return {
      success: true,
      message: 'Track-movement link removed, ready for re-analysis',
    };
  } catch (error) {
    console.error('Error removing track-movement link:', error);
    throw new Error('Failed to remove track-movement link');
  }
}
