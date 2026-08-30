import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/lib/db';
import {
  composer,
  recordingTrackV2,
  recordingV2,
  trackWorkPartV2,
  work,
  workCatalogV2,
  workPartV2,
  metadataMigrationAudit,
} from '@/lib/db/schema';
import {
  cleanWorkPartLabel,
  cleanWorkPartTitle,
  normalizeCatalogNumber,
  normalizeCatalogSystem,
  normalizeMetadataText,
} from '@/lib/classical-normalization';
import type { ClassicalMetadataV2 } from '@/lib/classical-parser';
import {
  collapseCartesianPartAssignments,
  selectRecordingMatch,
} from '@/lib/recording-matching';

export type V2TrackInput = {
  id: string;
  discNumber: number;
  trackNumber: number;
};

let composerRowsPromise: Promise<Array<{ id: number; name: string }>> | null = null;

async function getComposerRows() {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      composerRowsPromise ??= db.select({ id: composer.id, name: composer.name }).from(composer);
      return await composerRowsPromise;
    } catch (error) {
      composerRowsPromise = null;
      if (attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1_000 * 2 ** attempt));
    }
  }
  return [];
}

export async function seedWorkCatalogV2() {
  const works = await db.select().from(work);
  const rows = works.flatMap((item) =>
    item.catalogSystem && item.catalogNumber
      ? [
          {
            workId: item.id,
            system: item.catalogSystem,
            number: item.catalogNumber,
            normalizedSystem: normalizeCatalogSystem(item.catalogSystem),
            normalizedNumber: normalizeCatalogNumber(item.catalogNumber),
            isPrimary: true,
          },
        ]
      : [],
  );
  for (let index = 0; index < rows.length; index += 200) {
    await db
      .insert(workCatalogV2)
      .values(rows.slice(index, index + 200))
      .onConflictDoNothing();
  }
  return rows.length;
}

export async function ensureWorkCatalogV2(
  workId: number,
  system: string | null,
  number: string | null,
) {
  if (!system || !number) return;
  await db
    .insert(workCatalogV2)
    .values({
      workId,
      system,
      number,
      normalizedSystem: normalizeCatalogSystem(system),
      normalizedNumber: normalizeCatalogNumber(number),
      isPrimary: true,
    })
    .onConflictDoNothing();
}

async function resolveComposerId(name: string | null) {
  if (!name) return null;
  const normalizedName = normalizeMetadataText(name.split('(')[0]);
  const rows = await getComposerRows();
  const exact = rows.filter((row) => normalizeMetadataText(row.name) === normalizedName);
  if (exact.length === 1) return exact[0].id;

  // Album credits and parsers often use only a composer's surname ("Mozart")
  // while the canonical row stores the full name. Accept that only when it is
  // unique, so common or ambiguous surnames remain unresolved for review.
  const requestedSurname = normalizedName.split(' ').at(-1);
  const partial = rows.filter((row) => {
    const canonicalName = normalizeMetadataText(row.name);
    const canonicalSurname = canonicalName.split(' ').at(-1);
    return (
      canonicalName.endsWith(` ${normalizedName}`) ||
      normalizedName.endsWith(` ${canonicalName}`) ||
      (requestedSurname && canonicalSurname === requestedSurname)
    );
  });
  return partial.length === 1 ? partial[0].id : null;
}

export async function resolveWorkV2(metadata: ClassicalMetadataV2) {
  const composerId = await resolveComposerId(metadata.composerName);
  if (!composerId) return null;

  if (metadata.catalogSystem && metadata.catalogNumber) {
    const candidates = await db
      .select({ id: work.id, title: work.title })
      .from(workCatalogV2)
      .innerJoin(work, eq(workCatalogV2.workId, work.id))
      .where(
        and(
          eq(work.composerId, composerId),
          eq(workCatalogV2.normalizedSystem, normalizeCatalogSystem(metadata.catalogSystem)),
          eq(workCatalogV2.normalizedNumber, normalizeCatalogNumber(metadata.catalogNumber)),
        ),
      );
    const audits =
      candidates.length > 0
        ? await db
            .select({
              sourceId: metadataMigrationAudit.sourceId,
              targetId: metadataMigrationAudit.targetId,
            })
            .from(metadataMigrationAudit)
            .where(
              and(
                eq(metadataMigrationAudit.entityType, 'work'),
                inArray(
                  metadataMigrationAudit.sourceId,
                  candidates.map((candidate) => String(candidate.id)),
                ),
              ),
            )
        : [];
    const targetBySource = new Map(audits.map((audit) => [audit.sourceId, audit.targetId]));
    const canonicalCandidates = [
      ...new Map(
        candidates.map((candidate) => {
          const mapped = targetBySource.get(String(candidate.id));
          const id = mapped ? Number(mapped) : candidate.id;
          return [id, { ...candidate, id }];
        }),
      ).values(),
    ];
    const title = normalizeMetadataText(metadata.formalName);
    const exact = canonicalCandidates.filter(
      (candidate) => normalizeMetadataText(candidate.title) === title,
    );
    if (exact.length === 1) return exact[0].id;
    if (canonicalCandidates.length === 1) return canonicalCandidates[0].id;
    return null;
  }

  const candidates = await db
    .select({ id: work.id, title: work.title })
    .from(work)
    .where(eq(work.composerId, composerId));
  const title = normalizeMetadataText(metadata.formalName);
  const exact = candidates.filter((candidate) => normalizeMetadataText(candidate.title) === title);
  return exact.length === 1 ? exact[0].id : null;
}

async function resolveWorkPart(workId: number, candidate: ClassicalMetadataV2['parts'][number]) {
  const label = cleanWorkPartLabel(candidate.label, candidate.title);
  candidate = { ...candidate, label, title: cleanWorkPartTitle(label, candidate.title) };
  const existing = await db.select().from(workPartV2).where(eq(workPartV2.workId, workId));
  const normalizedTitle = normalizeMetadataText(candidate.title);
  const normalizedLabel = normalizeMetadataText(candidate.label);
  const preserveCanonicalPosition = async (part: (typeof existing)[number]) => {
    if (candidate.label || candidate.title) {
      await db
        .update(workPartV2)
        .set({ label: candidate.label ?? part.label, title: candidate.title })
        .where(eq(workPartV2.id, part.id));
    }
    return { id: part.id, status: 'confirmed' as const };
  };
  const exact = existing.filter(
    (part) =>
      normalizeMetadataText(part.title) === normalizedTitle &&
      normalizeMetadataText(part.label) === normalizedLabel,
  );
  if (exact.length === 1) return preserveCanonicalPosition(exact[0]);

  const titleMatches = normalizedTitle
    ? existing.filter((part) => normalizeMetadataText(part.title) === normalizedTitle)
    : [];
  if (titleMatches.length === 1) return preserveCanonicalPosition(titleMatches[0]);

  const occupant = existing.find((part) => part.position === candidate.position);
  if (
    occupant &&
    (!normalizedTitle ||
      !normalizeMetadataText(occupant.title) ||
      normalizeMetadataText(occupant.title) === normalizedTitle)
  ) {
    await db
      .update(workPartV2)
      .set({ label: candidate.label, title: candidate.title })
      .where(eq(workPartV2.id, occupant.id));
    return { id: occupant.id, status: 'confirmed' as const };
  }

  const usedPositions = new Set(existing.map((part) => part.position));
  let position = candidate.position;
  let status: 'confirmed' | 'needs_review' = 'confirmed';
  if (occupant) {
    position = Math.max(0, ...usedPositions) + 1;
    while (usedPositions.has(position)) position += 1;
    status = 'needs_review';
  }
  const [created] = await db
    .insert(workPartV2)
    .values({
      workId,
      position,
      label: candidate.label,
      title: candidate.title,
    })
    .returning({ id: workPartV2.id });
  return { id: created.id, status };
}

async function reconcileRecording(spotifyAlbumId: string, workId: number, trackIds: string[]) {
  const candidates = await db
    .select({ id: recordingV2.id })
    .from(recordingV2)
    .where(and(eq(recordingV2.spotifyAlbumId, spotifyAlbumId), eq(recordingV2.workId, workId)));
  const memberships: Array<{ id: number; trackIds: string[] }> = [];
  for (const candidate of candidates) {
    const members = await db
      .select({ id: recordingTrackV2.spotifyTrackId })
      .from(recordingTrackV2)
      .where(eq(recordingTrackV2.recordingId, candidate.id));
    memberships.push({ id: candidate.id, trackIds: members.map((member) => member.id) });
  }
  let recordingId = selectRecordingMatch(trackIds, memberships);
  if (!recordingId) {
    const [created] = await db
      .insert(recordingV2)
      .values({ spotifyAlbumId, workId, popularity: null })
      .returning({ id: recordingV2.id });
    recordingId = created.id;
  }
  await db.delete(recordingTrackV2).where(eq(recordingTrackV2.recordingId, recordingId));
  if (trackIds.length > 0) {
    await db.delete(recordingTrackV2).where(inArray(recordingTrackV2.spotifyTrackId, trackIds));
    await db.insert(recordingTrackV2).values(
      trackIds.map((spotifyTrackId, position) => ({
        recordingId: recordingId!,
        spotifyTrackId,
        position: position + 1,
      })),
    );
  }
  return recordingId;
}

export async function saveParsedAlbumV2(
  spotifyAlbumId: string,
  tracks: V2TrackInput[],
  parsed: ClassicalMetadataV2[],
) {
  const resolved = await Promise.all(
    tracks.map(async (track, index) => ({
      track,
      metadata: parsed[index],
      workId: parsed[index]?.isClassical ? await resolveWorkV2(parsed[index]) : null,
    })),
  );
  const groups = new Map<string, typeof resolved>();
  const groupRepresentatives: Array<{
    key: string;
    workId: number;
    tokens: Set<string>;
    maxPartPosition: number;
  }> = [];
  for (const item of resolved) {
    if (!item.metadata?.isClassical || !item.workId || !item.metadata.recordingGroup) continue;
    const normalizedGroup = normalizeMetadataText(item.metadata.recordingGroup);
    const tokens = new Set(normalizedGroup.split(' ').filter(Boolean));
    const firstPartPosition = Math.min(
      ...item.metadata.parts.map((part) => part.position),
      Number.POSITIVE_INFINITY,
    );
    const similar = groupRepresentatives.find((representative) => {
      if (representative.workId !== item.workId) return false;
      const intersection = [...tokens].filter((token) => representative.tokens.has(token)).length;
      const union = new Set([...tokens, ...representative.tokens]).size;
      const isSequentialContinuation =
        Number.isFinite(firstPartPosition) &&
        firstPartPosition > representative.maxPartPosition &&
        firstPartPosition - representative.maxPartPosition <= 2;
      return (union > 0 && intersection / union >= 0.55) || isSequentialContinuation;
    });
    const key = similar?.key ?? `${item.workId}:${normalizedGroup}`;
    const maxPartPosition = Math.max(
      ...item.metadata.parts.map((part) => part.position),
      firstPartPosition,
    );
    if (similar) similar.maxPartPosition = Math.max(similar.maxPartPosition, maxPartPosition);
    else groupRepresentatives.push({ key, workId: item.workId, tokens, maxPartPosition });
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }

  let confirmed = 0;
  let needsReview = 0;
  for (const items of groups.values()) {
    const workId = items[0].workId!;
    const ordered = [...items].sort(
      (a, b) =>
        a.track.discNumber - b.track.discNumber || a.track.trackNumber - b.track.trackNumber,
    );
    const collapsedPartSets = collapseCartesianPartAssignments(
      ordered.map((item) => item.metadata.parts),
    );
    ordered.forEach((item, index) => {
      item.metadata.parts = collapsedPartSets[index];
    });
    await reconcileRecording(
      spotifyAlbumId,
      workId,
      ordered.map((item) => item.track.id),
    );
    for (const item of ordered) {
      if (item.metadata.parts.length === 0) {
        await db
          .update(trackWorkPartV2)
          .set({ matchStatus: 'needs_review' })
          .where(eq(trackWorkPartV2.spotifyTrackId, item.track.id));
        needsReview++;
        continue;
      }
      const links = new Map<number, typeof trackWorkPartV2.$inferInsert>();
      for (const part of item.metadata.parts) {
        const resolvedPart = await resolveWorkPart(workId, part);
        links.set(resolvedPart.id, {
          spotifyTrackId: item.track.id,
          workPartId: resolvedPart.id,
          startMs: null,
          endMs: null,
          matchSource: 'parser' as const,
          matchStatus: resolvedPart.status,
        });
        if (resolvedPart.status === 'confirmed') confirmed++;
        else needsReview++;
      }
      await db.delete(trackWorkPartV2).where(eq(trackWorkPartV2.spotifyTrackId, item.track.id));
      await db.insert(trackWorkPartV2).values([...links.values()]);
    }
  }
  return {
    groups: groups.size,
    confirmed,
    needsReview,
    unresolved: resolved.filter((item) => item.metadata?.isClassical && !item.workId).length,
  };
}
