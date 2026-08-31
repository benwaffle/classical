/**
 * Collapse works that share a composer and a canonical catalog identity.
 *
 * The metadata pipeline receives the same catalog reference in many surface
 * forms (`Op. 34 No. 2`, `Op 34/2`, `Hob. VIIe:1`, `Hob VIIe/1`), and the
 * `work` uniqueness indexes compare the raw text, so each new spelling creates
 * another row for a work we already have. Beyond the duplicate listings, those
 * rows make `upsertWork` reject the catalog identity as ambiguous, so ingestion
 * of the affected works stops until they are collapsed.
 *
 * Same composer plus same canonical catalog identity is a deterministic
 * statement that two rows are the same work — it is not a similarity guess.
 * Movements are a weaker signal, so parts are merged only on the same
 * deterministic key the validator uses to flag duplicate candidates; anything
 * else moves across intact and stays visible in the review backlog.
 *
 * Works recorded in `metadata_migration_audit` as `keep_separate` are excluded,
 * which is how a reviewed "these really are different pieces" decision is made
 * durable.
 *
 * Dry run by default. Pass --apply to write.
 */
import { loadEnvConfig } from '@next/env';

async function main() {
  const apply = process.argv.includes('--apply');
  loadEnvConfig(process.cwd());
  if (!process.env.TURSO_DATABASE_URL) {
    throw new Error('TURSO_DATABASE_URL is required');
  }

  const [{ db }, schema, drizzle, normalization, { refreshRecordingPopularity }] =
    await Promise.all([
      import('@/lib/db'),
      import('@/lib/db/schema'),
      import('drizzle-orm'),
      import('@/lib/classical-normalization'),
      import('@/lib/recording-popularity'),
    ]);
  const { and, eq, sql } = drizzle;
  const { canonicalCatalogKey, normalizeMetadataText, possiblePartDuplicateKey } = normalization;

  // Counted with grouped queries rather than correlated subqueries: drizzle
  // renders an interpolated column unqualified, so `${work.id}` inside a
  // subquery binds to the subquery's own table instead of the outer row.
  const [rows, partCounts, recordingCounts, linkCounts, keepSeparate] = await Promise.all([
    db
      .select({
        id: schema.work.id,
        composerId: schema.work.composerId,
        title: schema.work.title,
        nickname: schema.work.nickname,
        catalogSystem: schema.work.catalogSystem,
        catalogNumber: schema.work.catalogNumber,
        yearComposed: schema.work.yearComposed,
        form: schema.work.form,
      })
      .from(schema.work),
    db
      .select({ workId: schema.workPartV2.workId, value: drizzle.count() })
      .from(schema.workPartV2)
      .groupBy(schema.workPartV2.workId),
    db
      .select({ workId: schema.recordingV2.workId, value: drizzle.count() })
      .from(schema.recordingV2)
      .groupBy(schema.recordingV2.workId),
    db
      .select({ workId: schema.workPartV2.workId, value: drizzle.count() })
      .from(schema.trackWorkPartV2)
      .innerJoin(schema.workPartV2, eq(schema.workPartV2.id, schema.trackWorkPartV2.workPartId))
      .groupBy(schema.workPartV2.workId),
    db
      .select({ sourceId: schema.metadataMigrationAudit.sourceId })
      .from(schema.metadataMigrationAudit)
      .where(
        and(
          eq(schema.metadataMigrationAudit.entityType, 'work'),
          eq(schema.metadataMigrationAudit.decision, 'keep_separate'),
        ),
      ),
  ]);
  const index = (counted: { workId: number; value: number }[]) =>
    new Map(counted.map((row) => [row.workId, row.value]));
  const [partsByWork, recordingsByWork, linksByWork] = [
    partCounts,
    recordingCounts,
    linkCounts,
  ].map(index);
  const works = rows.map((work) => ({
    ...work,
    parts: partsByWork.get(work.id) ?? 0,
    recordings: recordingsByWork.get(work.id) ?? 0,
    links: linksByWork.get(work.id) ?? 0,
  }));
  const excluded = new Set(keepSeparate.map((row) => Number(row.sourceId)));

  const groups = new Map<string, typeof works>();
  for (const work of works) {
    if (excluded.has(work.id)) continue;
    const key = canonicalCatalogKey(work.catalogSystem, work.catalogNumber);
    if (!key) continue;
    const groupKey = `${work.composerId}:${key}`;
    groups.set(groupKey, [...(groups.get(groupKey) ?? []), work]);
  }

  // The row real listening data already points at wins; ties fall back to the
  // oldest id so repeated runs choose the same survivor.
  const rank = (members: typeof works) =>
    [...members].sort(
      (left, right) =>
        right.links - left.links ||
        right.parts - left.parts ||
        right.recordings - left.recordings ||
        left.id - right.id,
    );

  let plan = [...groups.entries()]
    .filter(([, members]) => members.length > 1)
    .map(([key, members]) => {
      const ranked = rank(members);
      return {
        key,
        context: `catalog identity ${key}`,
        survivor: ranked[0],
        sources: ranked.slice(1),
      };
    })
    .sort((left, right) => left.survivor.id - right.survivor.id);

  // A reviewed merge list handles the cases no rule can decide: rows that are
  // the same work but state no catalog, or state it in a different system.
  const pairsFlag = process.argv.indexOf('--pairs');
  if (pairsFlag >= 0) {
    const path = process.argv[pairsFlag + 1];
    if (!path) throw new Error('--pairs needs a JSON file of { reason, workIds } entries');
    const byId = new Map(works.map((work) => [work.id, work]));
    const reviewed: { reason: string; workIds: number[] }[] = JSON.parse(
      await (await import('node:fs/promises')).readFile(path, 'utf8'),
    );
    plan = reviewed.map(({ reason, workIds }) => {
      const members = workIds.map((id) => {
        const work = byId.get(id);
        if (!work) throw new Error(`Reviewed merge names work ${id}, which does not exist`);
        return work;
      });
      const ranked = rank(members);
      return {
        key: reason,
        context: `reviewed merge — ${reason}`,
        survivor: ranked[0],
        sources: ranked.slice(1),
      };
    });
  }

  const counts = {
    groups: plan.length,
    sourceWorks: 0,
    partsMerged: 0,
    partsMoved: 0,
    linksRepointed: 0,
    recordingsMerged: 0,
    recordingsMoved: 0,
  };
  const touchedRecordings = new Set<number>();

  for (const { key, context, survivor, sources } of plan) {
    console.log(`\n${key}  survivor ${survivor.id} ${JSON.stringify(survivor.title)}`);

    const survivorParts = await db
      .select({
        id: schema.workPartV2.id,
        position: schema.workPartV2.position,
        label: schema.workPartV2.label,
        title: schema.workPartV2.title,
      })
      .from(schema.workPartV2)
      .where(eq(schema.workPartV2.workId, survivor.id));

    const partByIdentity = new Map<string, number>();
    const takenPositions = new Set<number>();
    for (const part of survivorParts) {
      const identity =
        possiblePartDuplicateKey(part.label, part.title) || normalizeMetadataText(part.title);
      if (identity && !partByIdentity.has(identity)) partByIdentity.set(identity, part.id);
      takenPositions.add(part.position);
    }
    let cursor = Math.max(0, ...survivorParts.map((part) => part.position)) + 1;
    const nextFreePosition = () => {
      while (takenPositions.has(cursor)) cursor += 1;
      return cursor;
    };

    for (const source of sources) {
      counts.sourceWorks += 1;
      console.log(
        `  <- ${source.id} ${JSON.stringify(source.title)} ` +
          `(${source.parts} parts, ${source.recordings} recordings, ${source.links} links)`,
      );

      const parts = await db
        .select({
          id: schema.workPartV2.id,
          position: schema.workPartV2.position,
          label: schema.workPartV2.label,
          title: schema.workPartV2.title,
        })
        .from(schema.workPartV2)
        .where(eq(schema.workPartV2.workId, source.id))
        .orderBy(schema.workPartV2.position);

      for (const part of parts) {
        const identity =
          possiblePartDuplicateKey(part.label, part.title) || normalizeMetadataText(part.title);
        const target = identity ? partByIdentity.get(identity) : undefined;
        const display = [part.label, part.title].filter(Boolean).join(' ').trim();

        if (target !== undefined) {
          const [{ value: links }] = await db
            .select({ value: drizzle.count() })
            .from(schema.trackWorkPartV2)
            .where(eq(schema.trackWorkPartV2.workPartId, part.id));
          counts.partsMerged += 1;
          counts.linksRepointed += links;
          console.log(
            `     part ${part.id} ${JSON.stringify(display)} -> ${target} (${links} links)`,
          );
          if (apply) {
            // A track can already carry the survivor part; drop the loser row
            // instead of failing the composite primary key.
            await db.run(
              sql`UPDATE OR IGNORE track_work_part_v2 SET work_part_id = ${target} WHERE work_part_id = ${part.id}`,
            );
            await db
              .delete(schema.trackWorkPartV2)
              .where(eq(schema.trackWorkPartV2.workPartId, part.id));
            await db.run(
              sql`INSERT OR IGNORE INTO metadata_migration_audit (entity_type, source_id, target_id, decision, reason)
                  VALUES ('work_part_v2', ${String(part.id)}, ${String(target)}, 'merged',
                          ${`Same part identity inside merged ${context}`})`,
            );
            await db.delete(schema.workPartV2).where(eq(schema.workPartV2.id, part.id));
          }
        } else {
          const position = takenPositions.has(part.position) ? nextFreePosition() : part.position;
          takenPositions.add(position);
          if (identity) partByIdentity.set(identity, part.id);
          counts.partsMoved += 1;
          console.log(
            `     part ${part.id} ${JSON.stringify(display)} kept at position ${position}`,
          );
          if (apply) {
            await db
              .update(schema.workPartV2)
              .set({ workId: survivor.id, position })
              .where(eq(schema.workPartV2.id, part.id));
          }
        }
      }

      const recordings = await db
        .select({ id: schema.recordingV2.id, spotifyAlbumId: schema.recordingV2.spotifyAlbumId })
        .from(schema.recordingV2)
        .where(eq(schema.recordingV2.workId, source.id));

      for (const recording of recordings) {
        const [existing] = await db
          .select({ id: schema.recordingV2.id })
          .from(schema.recordingV2)
          .where(
            and(
              eq(schema.recordingV2.workId, survivor.id),
              eq(schema.recordingV2.spotifyAlbumId, recording.spotifyAlbumId),
            ),
          )
          .orderBy(schema.recordingV2.id)
          .limit(1);

        if (existing) {
          counts.recordingsMerged += 1;
          touchedRecordings.add(existing.id);
          console.log(
            `     recording ${recording.id} (${recording.spotifyAlbumId}) -> ${existing.id}`,
          );
          if (apply) {
            await db
              .update(schema.recordingTrackV2)
              .set({ recordingId: existing.id })
              .where(eq(schema.recordingTrackV2.recordingId, recording.id));
            await db.run(
              sql`INSERT OR IGNORE INTO metadata_migration_audit (entity_type, source_id, target_id, decision, reason)
                  VALUES ('recording_v2', ${String(recording.id)}, ${String(existing.id)}, 'merged',
                          ${`Same album under merged ${context}`})`,
            );
            await db.delete(schema.recordingV2).where(eq(schema.recordingV2.id, recording.id));
          }
        } else {
          counts.recordingsMoved += 1;
          touchedRecordings.add(recording.id);
          console.log(`     recording ${recording.id} (${recording.spotifyAlbumId}) reassigned`);
          if (apply) {
            await db
              .update(schema.recordingV2)
              .set({ workId: survivor.id })
              .where(eq(schema.recordingV2.id, recording.id));
          }
        }
      }

      if (apply) {
        // Carry over catalog references the survivor does not already state.
        const [survivorCatalogs, sourceCatalogs] = await Promise.all([
          db
            .select({ system: schema.workCatalogV2.system, number: schema.workCatalogV2.number })
            .from(schema.workCatalogV2)
            .where(eq(schema.workCatalogV2.workId, survivor.id)),
          db
            .select({
              system: schema.workCatalogV2.system,
              number: schema.workCatalogV2.number,
              normalizedSystem: schema.workCatalogV2.normalizedSystem,
              normalizedNumber: schema.workCatalogV2.normalizedNumber,
            })
            .from(schema.workCatalogV2)
            .where(eq(schema.workCatalogV2.workId, source.id)),
        ]);
        const known = new Set(
          survivorCatalogs.map((row) => canonicalCatalogKey(row.system, row.number)),
        );
        const carried = sourceCatalogs.filter(
          (row) => !known.has(canonicalCatalogKey(row.system, row.number)),
        );
        if (carried.length > 0) {
          await db
            .insert(schema.workCatalogV2)
            .values(carried.map((row) => ({ ...row, workId: survivor.id, isPrimary: false })))
            .onConflictDoNothing();
        }
        await db.delete(schema.workCatalogV2).where(eq(schema.workCatalogV2.workId, source.id));
        await db.run(
          sql`INSERT INTO metadata_migration_audit (entity_type, source_id, target_id, decision, reason)
              VALUES ('work', ${String(source.id)}, ${String(survivor.id)}, 'merge',
                      ${`Same composer and ${context}`})
              ON CONFLICT (entity_type, source_id) DO UPDATE SET target_id = excluded.target_id,
                decision = excluded.decision, reason = excluded.reason`,
        );
        await db.delete(schema.work).where(eq(schema.work.id, source.id));
      }
    }

    // Prefer a real value from a merged row over a gap on the survivor.
    const fill: Record<string, string | number> = {};
    for (const field of ['nickname', 'yearComposed', 'form'] as const) {
      if (survivor[field] != null && survivor[field] !== '') continue;
      const donor = sources.find((source) => source[field] != null && source[field] !== '');
      if (donor) fill[field] = donor[field] as string | number;
    }
    // A catalog reference only means anything as a system/number pair, so it is
    // adopted from one donor or not at all.
    if (!canonicalCatalogKey(survivor.catalogSystem, survivor.catalogNumber)) {
      const donor = sources.find((source) =>
        canonicalCatalogKey(source.catalogSystem, source.catalogNumber),
      );
      if (donor) {
        fill.catalogSystem = donor.catalogSystem as string;
        fill.catalogNumber = donor.catalogNumber as string;
      }
    }
    if (Object.keys(fill).length > 0) {
      console.log(`     survivor gains ${JSON.stringify(fill)}`);
      if (apply) await db.update(schema.work).set(fill).where(eq(schema.work.id, survivor.id));
    }
    if (apply) {
      await db.run(
        sql`INSERT INTO metadata_migration_audit (entity_type, source_id, target_id, decision, reason)
            VALUES ('work', ${String(survivor.id)}, ${String(survivor.id)}, 'canonical',
                    ${`Canonical work for ${context}`})
            ON CONFLICT (entity_type, source_id) DO UPDATE SET target_id = excluded.target_id,
              decision = excluded.decision, reason = excluded.reason`,
      );
    }
  }

  if (apply) {
    for (const recordingId of touchedRecordings) {
      await refreshRecordingPopularity(recordingId);
    }
  }

  console.log('\n' + JSON.stringify(counts, null, 2));
  console.log(apply ? '\nApplied.' : '\nDry run. Re-run with --apply to write.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
