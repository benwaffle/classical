import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatWorkPart,
  cleanWorkPartLabel,
  cleanWorkPartTitle,
  normalizeCatalogNumber,
  normalizeCatalogSystem,
  splitPartLabel,
  toRoman,
} from '../app/lib/classical-normalization';
import { selectRecordingMatch } from '../app/lib/recording-matching';

test('normalizes catalog punctuation without changing display data', () => {
  assert.equal(normalizeCatalogSystem('K.'), normalizeCatalogSystem(' K '));
  assert.equal(normalizeCatalogNumber('6 No. 4'), normalizeCatalogNumber('6 No.4'));
});

test('extracts labels and renders them exactly once', () => {
  const part = splitPartLabel(4, 'IV. Offertorium: 2. Hostias');
  assert.deepEqual(part, { label: 'IV', title: 'Offertorium: 2. Hostias' });
  assert.equal(formatWorkPart(part.label, part.title), 'IV. Offertorium: 2. Hostias');
  assert.deepEqual(splitPartLabel(3, 'Lacrimosa'), { label: 'III', title: 'Lacrimosa' });
  assert.equal(toRoman(24), 'XXIV');
  assert.equal(cleanWorkPartLabel('VIII. Communio', 'Communio'), 'VIII');
  assert.equal(cleanWorkPartLabel('III.', 'Dies irae'), 'III');
  assert.equal(cleanWorkPartTitle('Fuga', 'Fuga. Allegro, ma non troppo'), 'Allegro, ma non troppo');
  assert.equal(cleanWorkPartTitle('I', 'Introitus'), 'Introitus');
});

test('matches recordings by exact membership before overlap', () => {
  assert.equal(
    selectRecordingMatch(
      ['a', 'b'],
      [
        { id: 1, trackIds: ['a'] },
        { id: 2, trackIds: ['a', 'b'] },
      ],
    ),
    2,
  );
});

test('uses a unique greatest overlap and rejects ties', () => {
  assert.equal(
    selectRecordingMatch(
      ['a', 'b', 'c'],
      [
        { id: 1, trackIds: ['a', 'b'] },
        { id: 2, trackIds: ['c'] },
      ],
    ),
    1,
  );
  assert.equal(
    selectRecordingMatch(
      ['a', 'b'],
      [
        { id: 1, trackIds: ['a'] },
        { id: 2, trackIds: ['b'] },
      ],
    ),
    null,
  );
});
