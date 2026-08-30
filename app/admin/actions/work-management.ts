'use server';

import { db } from '@/lib/db';
import {
  composer,
  recordingV2,
  spotifyAlbum,
  trackWorkPartV2,
  work,
  workPartV2,
  workCatalogV2,
} from '@/lib/db/schema';
import { and, count, eq, like, or, sql } from 'drizzle-orm';
import { checkAuth } from './auth';
import type { ComposerRow, RecordingRow, WorkRow } from './schema-types';
import { normalizeCatalogNumber, normalizeCatalogSystem } from '@/lib/classical-normalization';

export type AdminWorkPart = {
  id: number;
  workId: number;
  position: number;
  label: string | null;
  title: string | null;
};

export interface WorkWithDetails extends WorkRow {
  composerName: string;
  movementCount: number;
  recordingCount: number;
}

export async function searchWorks(
  query?: string,
  composerId?: number,
  catalogSystem?: string,
  limit = 50,
  offset = 0,
): Promise<{ items: WorkWithDetails[]; total: number }> {
  await checkAuth();

  const conditions = [];
  if (query?.trim()) {
    const searchPattern = `%${query}%`;
    conditions.push(
      or(
        like(work.title, searchPattern),
        like(work.nickname, searchPattern),
        like(work.catalogNumber, searchPattern),
      ),
    );
  }
  if (composerId !== undefined) {
    conditions.push(eq(work.composerId, composerId));
  }
  if (catalogSystem?.trim()) {
    conditions.push(eq(work.catalogSystem, catalogSystem));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const itemsQuery = db
    .select({
      id: work.id,
      composerId: work.composerId,
      title: work.title,
      nickname: work.nickname,
      catalogSystem: work.catalogSystem,
      catalogNumber: work.catalogNumber,
      yearComposed: work.yearComposed,
      form: work.form,
      composerName: composer.name,
      movementCount: sql<number>`(SELECT COUNT(*) FROM work_part_v2 WHERE work_part_v2.work_id = ${work.id})`,
      recordingCount: sql<number>`(SELECT COUNT(*) FROM recording_v2 WHERE recording_v2.work_id = ${work.id})`,
    })
    .from(work)
    .innerJoin(composer, eq(work.composerId, composer.id))
    .where(whereClause)
    .orderBy(composer.name, work.catalogSystem, work.catalogNumber, work.title)
    .limit(limit)
    .offset(offset);

  const totalQuery = db.select({ count: count() }).from(work).where(whereClause);

  const [items, [{ count: total }]] = await Promise.all([itemsQuery, totalQuery]);

  return { items: items as WorkWithDetails[], total };
}

export async function getWorkWithDetails(workId: number): Promise<{
  work: WorkRow;
  composer: ComposerRow;
  movements: AdminWorkPart[];
  recordings: Array<RecordingRow & { albumTitle: string }>;
} | null> {
  await checkAuth();

  const [workRow] = await db.select().from(work).where(eq(work.id, workId)).limit(1);
  if (!workRow) return null;

  const [composerRow] = await db
    .select()
    .from(composer)
    .where(eq(composer.id, workRow.composerId))
    .limit(1);

  const movementsData = await db
    .select()
    .from(workPartV2)
    .where(eq(workPartV2.workId, workId))
    .orderBy(workPartV2.position);

  const recordingsData = await db
    .select({
      id: recordingV2.id,
      spotifyAlbumId: recordingV2.spotifyAlbumId,
      workId: recordingV2.workId,
      popularity: recordingV2.popularity,
      albumTitle: spotifyAlbum.title,
    })
    .from(recordingV2)
    .innerJoin(spotifyAlbum, eq(recordingV2.spotifyAlbumId, spotifyAlbum.spotifyId))
    .where(eq(recordingV2.workId, workId));

  return {
    work: workRow,
    composer: composerRow,
    movements: movementsData,
    recordings: recordingsData,
  };
}

export async function createWork(data: {
  composerId: number;
  title: string;
  nickname?: string | null;
  catalogSystem?: string | null;
  catalogNumber?: string | null;
  yearComposed?: number | null;
  form?: string | null;
}): Promise<WorkRow> {
  await checkAuth();

  const [result] = await db
    .insert(work)
    .values({
      composerId: data.composerId,
      title: data.title,
      nickname: data.nickname ?? null,
      catalogSystem: data.catalogSystem ?? null,
      catalogNumber: data.catalogNumber ?? null,
      yearComposed: data.yearComposed ?? null,
      form: data.form ?? null,
    })
    .returning();

  if (data.catalogSystem && data.catalogNumber) {
    await db.insert(workCatalogV2).values({
      workId: result.id,
      system: data.catalogSystem,
      number: data.catalogNumber,
      normalizedSystem: normalizeCatalogSystem(data.catalogSystem),
      normalizedNumber: normalizeCatalogNumber(data.catalogNumber),
      isPrimary: true,
    });
  }

  return result;
}

export async function updateWorkDetails(
  workId: number,
  data: {
    title?: string;
    nickname?: string | null;
    catalogSystem?: string | null;
    catalogNumber?: string | null;
    yearComposed?: number | null;
    form?: string | null;
  },
): Promise<WorkRow> {
  await checkAuth();

  const updateData: Partial<typeof work.$inferInsert> = {};
  if (data.title !== undefined) updateData.title = data.title;
  if (data.nickname !== undefined) updateData.nickname = data.nickname;
  if (data.catalogSystem !== undefined) updateData.catalogSystem = data.catalogSystem;
  if (data.catalogNumber !== undefined) updateData.catalogNumber = data.catalogNumber;
  if (data.yearComposed !== undefined) updateData.yearComposed = data.yearComposed;
  if (data.form !== undefined) updateData.form = data.form;

  const [result] = await db.update(work).set(updateData).where(eq(work.id, workId)).returning();

  if (!result) {
    throw new Error('Work not found');
  }

  if (
    data.catalogSystem !== undefined &&
    data.catalogNumber !== undefined
  ) {
    await db.delete(workCatalogV2).where(eq(workCatalogV2.workId, workId));
    if (data.catalogSystem && data.catalogNumber) {
      await db.insert(workCatalogV2).values({
        workId,
        system: data.catalogSystem,
        number: data.catalogNumber,
        normalizedSystem: normalizeCatalogSystem(data.catalogSystem),
        normalizedNumber: normalizeCatalogNumber(data.catalogNumber),
        isPrimary: true,
      });
    }
  }

  return result;
}

export async function addMovementToWork(
  workId: number,
  position: number,
  label?: string | null,
  title?: string | null,
): Promise<AdminWorkPart> {
  await checkAuth();

  const [result] = await db
    .insert(workPartV2)
    .values({ workId, position, label: label ?? null, title: title ?? null })
    .returning();
  return result;
}

export async function updateMovementDetails(
  movementId: number,
  data: { position?: number; label?: string | null; title?: string | null },
): Promise<AdminWorkPart> {
  await checkAuth();

  const [result] = await db
    .update(workPartV2)
    .set(data)
    .where(eq(workPartV2.id, movementId))
    .returning();
  if (!result) throw new Error('Work part not found');
  return result;
}

export async function deleteMovement(movementId: number): Promise<void> {
  await checkAuth();

  const [linkedTrack] = await db
    .select()
    .from(trackWorkPartV2)
    .where(eq(trackWorkPartV2.workPartId, movementId))
    .limit(1);
  if (linkedTrack) throw new Error('Cannot delete work part: tracks are linked to it');
  await db.delete(workPartV2).where(eq(workPartV2.id, movementId));
}
