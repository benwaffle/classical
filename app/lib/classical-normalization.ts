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

function romanToInteger(value: string): number | null {
  // Movement numerals in this dataset are small. Restricting the accepted
  // grammar also keeps musical key labels such as C and D from being read as
  // the Roman numerals 100 and 500.
  if (!/^(?:x{0,3})(?:ix|iv|v?i{0,3})$/i.test(value)) return null;
  const values: Record<string, number> = { i: 1, v: 5, x: 10 };
  let total = 0;
  let previous = 0;
  for (const character of [...value.toLowerCase()].reverse()) {
    const current = values[character];
    total += current < previous ? -current : current;
    previous = current;
  }
  return total;
}

/**
 * A deliberately review-only key for finding likely duplicate movement rows.
 * It bridges display punctuation, Roman/Arabic numbering, and a leading English
 * article, but is never used to merge metadata automatically.
 */
export function possiblePartDuplicateKey(label: string | null, title: string | null) {
  const tokens = normalizeMetadataText([label, title].filter(Boolean).join(' ')).split(' ');
  if (tokens.length === 0 || !tokens[0]) return '';
  const number = romanToInteger(tokens[0]);
  if (number !== null) tokens[0] = String(number);
  return tokens.filter((token, index) => index === 0 || token !== 'the').join(' ');
}

/**
 * A single canonical identity for a catalog reference, e.g. `op34/2`.
 *
 * Catalog text reaches us in many surface forms for the same identity:
 * `Op. 34 No. 2` / `Op 34/2`, `Hob. VIIe:1` / `Hob VIIe/1`, and the Scarlatti
 * `Kk. 1` that some sources split into system `K` plus number `K.1`. Comparing
 * the system and the number separately cannot bridge those, so this joins them
 * and reduces every group separator to `/`.
 *
 * Returns `''` when the work is not catalogued, which never compares equal.
 */
export function canonicalCatalogKey(
  system: string | null | undefined,
  number: string | null | undefined,
) {
  if (!system?.trim() || !number?.trim()) return '';
  return `${system} ${number}`
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[,\s]*\bn[or]s?\.?\s*(?=[0-9ivx])/g, '/')
    .replace(/[:/]+/g, '/')
    .replace(/[^0-9a-z/]+/g, '')
    .replace(/\/+/g, '/')
    .replace(/^\/|\/$/g, '');
}
