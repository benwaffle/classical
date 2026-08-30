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
import {
  collapseCartesianPartAssignments,
  selectRecordingMatch,
} from '../app/lib/recording-matching';

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
  assert.equal(cleanWorkPartLabel('III. Menuetto', 'Allegro molto e vivace'), 'III');
  assert.equal(cleanWorkPartLabel('III.1', 'Dies irae'), 'III.1');
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

test('collapses an exact Cartesian track-to-part assignment', () => {
  const parts = [
    { position: 1, label: 'I', title: 'Allegro' },
    { position: 2, label: 'II', title: 'Larghetto' },
    { position: 3, label: 'III', title: 'Rondo' },
  ];
  assert.deepEqual(collapseCartesianPartAssignments([parts, parts, parts]), [
    [parts[0]],
    [parts[1]],
    [parts[2]],
  ]);
});

test('preserves genuine combined and asymmetric part assignments', () => {
  const first = [
    { position: 1, label: 'I', title: 'Prelude' },
    { position: 2, label: 'II', title: 'Fugue' },
  ];
  const second = [{ position: 3, label: 'III', title: 'Finale' }];
  assert.deepEqual(collapseCartesianPartAssignments([first]), [first]);
  assert.deepEqual(collapseCartesianPartAssignments([first, second]), [first, second]);
});
