import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatWorkPart,
  normalizeCatalogNumber,
  normalizeCatalogSystem,
  toRoman,
} from '../app/lib/classical-normalization';
import {
  collapseCartesianPartAssignments,
  selectRecordingMatch,
} from '../app/lib/recording-matching';
import { selectCanonicalWorkCandidate } from '../app/lib/work-matching';
import { likedSongsDatabaseName } from '../app/lib/liked-songs-cache';

test('normalizes catalog punctuation without changing display data', () => {
  assert.equal(normalizeCatalogSystem('K.'), normalizeCatalogSystem(' K '));
  assert.equal(normalizeCatalogNumber('6 No. 4'), normalizeCatalogNumber('6 No.4'));
});

test('renders stored labels and titles exactly once', () => {
  assert.equal(formatWorkPart('IV.2', 'Hostias'), 'IV.2. Hostias');
  assert.equal(formatWorkPart(null, 'Finale. Allegro brillante'), 'Finale. Allegro brillante');
  assert.equal(toRoman(24), 'XXIV');
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

test('uses normalized catalogue candidates without guessing across duplicates', () => {
  const base = {
    composerId: 1,
    nickname: null,
    catalogSystem: 'Op',
    catalogNumber: '71',
    yearComposed: null,
    form: null,
  };
  const candidates = [
    { ...base, id: 10, title: 'The Nutcracker' },
    { ...base, id: 11, title: 'The Nutcracker Suite' },
  ];
  assert.equal(selectCanonicalWorkCandidate(candidates, 'The Nutcracker')?.id, 10);
  assert.equal(selectCanonicalWorkCandidate(candidates, 'Nutcracker excerpts'), null);
});

test('isolates liked-song caches by authenticated user', () => {
  assert.notEqual(likedSongsDatabaseName('user-a'), likedSongsDatabaseName('user-b'));
});
