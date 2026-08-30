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

export function formatWorkPart(label: string | null, title: string | null) {
  if (label && title) return `${label}. ${title}`;
  return title ?? (label ? `${label}.` : '');
}
