import { normalizeMetadataText } from '@/lib/classical-normalization';

export function selectCanonicalWorkCandidate<T extends { title: string }>(
  candidates: T[],
  title: string,
): T | null {
  const exactTitle = candidates.filter(
    (candidate) => normalizeMetadataText(candidate.title) === normalizeMetadataText(title),
  );
  if (exactTitle.length === 1) return exactTitle[0];
  if (candidates.length === 1) return candidates[0];
  return null;
}
