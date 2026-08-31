export function selectRecordingMatch(
  desiredTrackIds: string[],
  candidates: Array<{ id: number; trackIds: string[] }>,
) {
  const desired = new Set(desiredTrackIds);
  const scored = candidates.map((candidate) => {
    const memberSet = new Set(candidate.trackIds);
    return {
      id: candidate.id,
      overlap: desiredTrackIds.filter((id) => memberSet.has(id)).length,
      exact: memberSet.size === desired.size && [...desired].every((id) => memberSet.has(id)),
    };
  });
  const exact = scored.find((candidate) => candidate.exact);
  if (exact) return exact.id;
  const ordered = scored.filter((item) => item.overlap > 0).sort((a, b) => b.overlap - a.overlap);
  if (ordered.length === 1 || (ordered[0] && ordered[0].overlap > (ordered[1]?.overlap ?? 0))) {
    return ordered[0]?.id ?? null;
  }
  return null;
}

type ParsedPart = { position: number; label: string | null; title: string | null };

function partSignature(part: ParsedPart) {
  return [
    part.position,
    part.label?.trim().toLowerCase() ?? '',
    part.title?.trim().toLowerCase() ?? '',
  ].join(':');
}

/**
 * Album parsers occasionally repeat the complete N-part work on each of N
 * sequential tracks. That is a Cartesian assignment, not N combined tracks.
 * Collapse only that exact, symmetric pattern; genuine combined/asymmetric
 * tracks are left untouched.
 */
export function collapseCartesianPartAssignments<T extends ParsedPart>(partSets: T[][]): T[][] {
  if (partSets.length < 2 || partSets.some((parts) => parts.length !== partSets.length)) {
    return partSets;
  }
  const signatures = partSets.map((parts) =>
    [...parts]
      .sort((a, b) => a.position - b.position || partSignature(a).localeCompare(partSignature(b)))
      .map(partSignature)
      .join('|'),
  );
  if (!signatures.every((signature) => signature === signatures[0])) return partSets;

  const orderedParts = [...partSets[0]].sort(
    (a, b) => a.position - b.position || partSignature(a).localeCompare(partSignature(b)),
  );
  if (new Set(orderedParts.map(partSignature)).size !== partSets.length) return partSets;
  return orderedParts.map((part) => [part]);
}
