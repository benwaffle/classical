import assert from 'node:assert/strict';
import test from 'node:test';
import {
  candidateIsSpecificEnough,
  titlesAreCompatible,
} from '../app/lib/metadata-matching';

test('recognizes equivalent title variants', () => {
  assert.equal(
    titlesAreCompatible('Requiem in D minor', 'Requiem in D Minor, K. 626'),
    true,
  );
});

test('rejects a generic candidate as less specific than the fallback', () => {
  assert.equal(candidateIsSpecificEnough('Piano Concerto', 'Piano Concerto No. 2 in C minor'), false);
  assert.equal(
    candidateIsSpecificEnough(
      'Piano Concerto No. 2 in C minor',
      'Piano Concerto No. 2 in C minor, Op. 18',
    ),
    true,
  );
});
