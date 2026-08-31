'use client';

import { useState } from 'react';
import { createComposerWithSpotify } from '../../actions/composer-management';
import {
  searchSpotifyArtistForImport,
  type SpotifyArtistSearchResult,
} from '../../actions/spotify-search';
import { Notice } from '../Notice';
import { Spinner } from '../Spinner';

type ImportResult = {
  input: { name: string; birthYear?: number; deathYear?: number };
  results: SpotifyArtistSearchResult[];
  selectedArtistId?: string;
};

function parseInputs(json: string) {
  const parsed = JSON.parse(json) as Array<{
    name: string;
    born?: number;
    died?: number;
    birthYear?: number;
    deathYear?: number;
  }>;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item.name !== 'string')) {
    throw new Error('JSON must be an array of composers with names');
  }
  return parsed.map((item) => ({
    name: item.name,
    birthYear: item.born ?? item.birthYear,
    deathYear: item.died ?? item.deathYear,
  }));
}

export function JsonComposerImport({
  onChanged,
}: {
  onChanged: (message: string) => Promise<void>;
}) {
  const [json, setJson] = useState('');
  const [results, setResults] = useState<ImportResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);

  const search = async () => {
    setSearching(true);
    setError(null);
    setResults([]);
    try {
      const inputs = parseInputs(json);
      setProgress({ current: 0, total: inputs.length });
      const found: ImportResult[] = [];
      for (let index = 0; index < inputs.length && found.length < 20; index++) {
        const result = await searchSpotifyArtistForImport(inputs[index]);
        setProgress({ current: index + 1, total: inputs.length });
        if (result.existingComposerId) continue;
        found.push({
          input: result.input,
          results: result.results,
          selectedArtistId:
            result.results[0]?.name.toLowerCase() === result.input.name.toLowerCase()
              ? result.results[0].id
              : undefined,
        });
      }
      setResults(found);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Invalid JSON');
    } finally {
      setSearching(false);
    }
  };

  const selected = results.filter((result) => result.selectedArtistId);
  const save = async () => {
    if (selected.length === 0) return;
    setSaving(true);
    setError(null);
    setProgress({ current: 0, total: selected.length });
    try {
      const outcomes = await Promise.allSettled(
        selected.map(async (item) => {
          const artist = item.results.find((candidate) => candidate.id === item.selectedArtistId);
          await createComposerWithSpotify({
            name: item.input.name,
            spotifyArtistId: item.selectedArtistId!,
            birthYear: item.input.birthYear,
            deathYear: item.input.deathYear,
            popularity: artist?.popularity ?? null,
            images: artist?.images ?? null,
          });
          setProgress((current) => ({ ...current, current: current.current + 1 }));
        }),
      );
      const saved = outcomes.filter((outcome) => outcome.status === 'fulfilled').length;
      const failed = outcomes.length - saved;
      if (failed > 0) setError(`${failed} composers could not be saved`);
      setResults([]);
      setJson('');
      await onChanged(`Saved ${saved} composers`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to finish the import');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="overflow-hidden rounded-lg border border-zinc-300 bg-white dark:border-zinc-700 dark:bg-zinc-900">
      <header className="border-b border-zinc-200 bg-zinc-100 px-4 py-3 dark:border-zinc-700 dark:bg-zinc-800">
        <h2 className="text-lg font-semibold text-black dark:text-white">
          Import Composers from JSON
        </h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Match a JSON list to Spotify, review it, and save selected composers
        </p>
      </header>
      <div className="space-y-4 p-4">
        {error && <Notice variant="error">{error}</Notice>}
        {results.length === 0 ? (
          <>
            <textarea
              value={json}
              onChange={(event) => setJson(event.target.value)}
              placeholder='[{"name":"Johann Sebastian Bach","born":1685,"died":1750}]'
              rows={6}
              className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 font-mono text-sm text-black dark:border-zinc-600 dark:bg-zinc-800 dark:text-white"
            />
            <button
              onClick={search}
              disabled={!json.trim() || searching}
              className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-white disabled:opacity-50"
            >
              {searching && <Spinner />}
              {searching ? `Searching ${progress.current}/${progress.total}...` : 'Search Spotify'}
            </button>
          </>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3 text-sm text-zinc-600 dark:text-zinc-400">
              <span>
                {results.length} results · {selected.length} selected
              </span>
              <div className="flex gap-2">
                <button onClick={() => setResults([])} className="rounded border px-3 py-1.5">
                  Clear
                </button>
                <button
                  onClick={save}
                  disabled={selected.length === 0 || saving}
                  className="flex items-center gap-2 rounded bg-green-600 px-3 py-1.5 text-white disabled:opacity-50"
                >
                  {saving && <Spinner />}
                  {saving
                    ? `Saving ${progress.current}/${progress.total}...`
                    : `Save ${selected.length}`}
                </button>
              </div>
            </div>
            <div className="max-h-96 space-y-3 overflow-y-auto rounded-lg border border-zinc-200 p-3 dark:border-zinc-700">
              {results.map((item, index) => (
                <fieldset
                  key={`${item.input.name}-${index}`}
                  className="border-b pb-3 last:border-0"
                >
                  <legend className="mb-2 font-medium text-black dark:text-white">
                    {item.input.name}
                  </legend>
                  <label className="mr-4 text-sm text-zinc-500">
                    <input
                      type="radio"
                      name={`composer-${index}`}
                      checked={!item.selectedArtistId}
                      onChange={() =>
                        setResults((current) =>
                          current.map((result, position) =>
                            position === index
                              ? { ...result, selectedArtistId: undefined }
                              : result,
                          ),
                        )
                      }
                    />{' '}
                    Skip
                  </label>
                  {item.results.map((artist) => (
                    <label
                      key={artist.id}
                      className="mr-4 text-sm text-zinc-700 dark:text-zinc-300"
                    >
                      <input
                        type="radio"
                        name={`composer-${index}`}
                        checked={item.selectedArtistId === artist.id}
                        onChange={() =>
                          setResults((current) =>
                            current.map((result, position) =>
                              position === index
                                ? { ...result, selectedArtistId: artist.id }
                                : result,
                            ),
                          )
                        }
                      />{' '}
                      {artist.name}
                    </label>
                  ))}
                </fieldset>
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
