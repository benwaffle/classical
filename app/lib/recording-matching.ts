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
