import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryBuilder } from 'drizzle-orm/sqlite-core';
import { mappedTrackCount } from '../app/lib/db/expressions';
import { recordingV2 } from '../app/lib/db/schema';
import {
  formatWorkPart,
  normalizeCatalogNumber,
  normalizeCatalogSystem,
  possiblePartDuplicateKey,
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

test('flags punctuation and numeral variants as possible duplicate parts', () => {
  assert.equal(
    possiblePartDuplicateKey('VII', "July. The Reaper's Song"),
    possiblePartDuplicateKey('7', 'July: Reaper’s Song'),
  );
  assert.notEqual(possiblePartDuplicateKey('C', 'major'), possiblePartDuplicateKey('100', 'major'));
  assert.notEqual(
    possiblePartDuplicateKey('D', 'flat major'),
    possiblePartDuplicateKey('500', 'flat major'),
  );
  assert.equal(possiblePartDuplicateKey(null, null), '');
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

test('the mapped-track count keeps its identifiers qualified in a single-table select', () => {
  /*
   * Drizzle strips table names from `sql` template columns selected over a
   * single table. That once collapsed this subquery's join to
   * `spotify_track_id = spotify_track_id`, which SQLite rejects as ambiguous
   * and which took down every work detail page.
   */
  const { sql: rendered } = new QueryBuilder()
    .select({ id: recordingV2.id, mapped: mappedTrackCount })
    .from(recordingV2)
    .toSQL();

  assert.match(
    rendered,
    /on "track_work_part_v2"\."spotify_track_id" = "recording_track_v2"\."spotify_track_id"/,
  );
  assert.match(rendered, /where "recording_track_v2"\."recording_id" = "recording_v2"\."id"/);
});
