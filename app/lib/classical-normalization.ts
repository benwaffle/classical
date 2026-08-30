const ROMAN_VALUES: Array<[number, string]> = [
  [1000, 'M'],
  [900, 'CM'],
  [500, 'D'],
  [400, 'CD'],
  [100, 'C'],
  [90, 'XC'],
  [50, 'L'],
  [40, 'XL'],
  [10, 'X'],
  [9, 'IX'],
  [5, 'V'],
  [4, 'IV'],
  [1, 'I'],
];

export function toRoman(value: number) {
  if (!Number.isInteger(value) || value < 1) return String(value);
  let remaining = value;
  let result = '';
  for (const [number, numeral] of ROMAN_VALUES) {
    while (remaining >= number) {
      result += numeral;
      remaining -= number;
    }
  }
  return result;
}

export function normalizeCatalogSystem(value: string) {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').replace(/[.\s]/g, '').toLowerCase();
}

export function normalizeCatalogNumber(value: string) {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').replace(/\s+/g, '').toLowerCase();
}

export function normalizeMetadataText(value: string | null | undefined) {
  return (value ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/\p{Pd}/gu, '-')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLowerCase();
}

const LEADING_LABEL = /^\s*((?:[IVXLCDM]+|\d+)(?:\.(?:[IVXLCDM]+|\d+))*)[.\s:-]+(.+)$/iu;

export function splitPartLabel(
  position: number,
  title: string | null,
): { label: string; title: string | null } {
  if (title) {
    const match = title.match(LEADING_LABEL);
    if (match) return { label: match[1], title: match[2].trim() || null };
  }
  return { label: toRoman(position), title };
}

export function formatWorkPart(label: string | null, title: string | null) {
  if (label && title) return `${label}. ${title}`;
  return title ?? (label ? `${label}.` : '');
}

const DESCRIPTIVE_ROMAN_LABEL =
  /^((?:[IVXLCDM]+)(?:\.(?:[IVXLCDM]+|\d+))*|\d+)[.\s:;-]+(.+)$/iu;

function mergeWorkPartTitle(leakedTitle: string, title: string | null) {
  if (!title) return leakedTitle;
  const normalizedLeaked = normalizeMetadataText(leakedTitle);
  const normalizedTitle = normalizeMetadataText(title);
  if (normalizedLeaked === normalizedTitle || normalizedTitle.includes(normalizedLeaked)) {
    return title;
  }
  if (normalizedLeaked.includes(normalizedTitle)) return leakedTitle;
  return `${leakedTitle}: ${title}`;
}

export function normalizeWorkPartFields(label: string | null, title: string | null) {
  if (!label) return { label, title };
  const trimmedLabel = label.replace(/[\s.:;]+$/gu, '').trim();
  const variation = trimmedLabel.match(/^((?:Variation|Var\.)\s+\d+)\s*\((.+)\)$/iu);
  if (variation) {
    return { label: variation[1], title: mergeWorkPartTitle(variation[2], title) };
  }
  const descriptiveFinale = trimmedLabel.match(/^Finale[.\s:;-]+(.+)$/iu);
  if (descriptiveFinale) {
    return { label: null, title: mergeWorkPartTitle(trimmedLabel, title) };
  }
  const match = trimmedLabel.match(DESCRIPTIVE_ROMAN_LABEL);
  if (!match || match[2].length < 2 || /^(?:[IVXLCDM]+|\d+)$/iu.test(match[2])) {
    return { label: trimmedLabel || null, title };
  }

  const structuralLabel = match[1];
  const leakedTitle = match[2].trim();
  return { label: structuralLabel, title: mergeWorkPartTitle(leakedTitle, title) };
}

export function cleanWorkPartLabel(label: string | null, title: string | null) {
  const normalized = normalizeWorkPartFields(label, title);
  if (!normalized.label) return normalized.label;
  const trimmedLabel = normalized.label;
  if (!title) return trimmedLabel || null;
  const normalizedLabel = normalizeMetadataText(trimmedLabel);
  const normalizedTitle = normalizeMetadataText(title);
  if (!normalizedLabel.endsWith(normalizedTitle)) return trimmedLabel;
  const titleIndex = trimmedLabel.toLocaleLowerCase().lastIndexOf(title.toLocaleLowerCase());
  if (titleIndex < 0) return trimmedLabel;
  return trimmedLabel.slice(0, titleIndex).replace(/[\s.:;\p{Pd}-]+$/gu, '').trim() || null;
}

export function cleanWorkPartTitle(label: string | null, title: string | null) {
  if (!label || !title) return title;
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const withoutRepeatedLabel = title.replace(
    new RegExp(`^${escapedLabel}(?:[\\s.:;\\-]+)`, 'iu'),
    '',
  );
  return withoutRepeatedLabel.trim() || title;
}
