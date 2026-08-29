import { generateText, Output } from 'ai';
import { z } from 'zod';

const classicalMetadataSchema = z.object({
  isClassical: z.boolean(),
  composerName: z
    .string()
    .nullable()
    .describe(
      "The name of the composer (e.g. 'Johann Sebastian Bach', 'Wolfgang Amadeus Mozart'). Infer it from the work title, catalog number, or album even when Spotify credits only performers. For self-composed contemporary classical music, the performer may be the composer. Null only if not classical or genuinely unknown",
    ),
  formalName: z
    .string()
    .describe(
      "The formal title of the entire work, e.g. 'Piano Concerto No. 3 in D minor', excluding catalog numbers or movement names",
    ),
  nickname: z.string().nullable().describe('Popular nickname like Moonlight Sonata, null if none'),
  catalogSystem: z
    .string()
    .nullable()
    .describe(
      'Catalog system: Op, RV, BWV, K, Kk, Hob, D, S, etc. Null if not classical or no catalog number. If the work has multiple catalog numbers, pick the most popular one.',
    ),
  catalogNumber: z
    .string()
    .nullable()
    .describe("Catalog number like '30', '30/3', '582', etc. Null if none"),
  form: z
    .string()
    .nullable()
    .describe("Musical form: 'concerto', 'sonata', 'symphony', 'fugue', 'prelude', etc."),
  movement: z
    .number()
    .nullable()
    .describe('Movement number (1, 2, 3, etc.), null if not applicable or unknown'),
  movementName: z
    .string()
    .nullable()
    .describe(
      "Movement name like 'Finale: Alla breve', 'Allegro', null if unknown. If it is a single-movement work, this can be the key of the piece",
    ),
  yearComposed: z.number().nullable().describe('Year the piece was composed, if known by the LLM'),
});

export type ClassicalMetadata = z.infer<typeof classicalMetadataSchema>;

const indexedClassicalMetadataSchema = classicalMetadataSchema.extend({
  inputIndex: z.number().int().positive().describe('The 1-based input track number'),
});

const albumBatchSchema = z.object({
  tracks: z.array(indexedClassicalMetadataSchema),
});

type TrackInput = { trackName: string; artistNames: string[] };
const MAX_TRACKS_PER_PARSE = 20;
const RATE_LIMIT_BACKOFF_MS = [15_000, 30_000, 60_000, 60_000];
const PARSER_MODEL = process.env.CLASSICAL_PARSER_MODEL ?? 'openai/gpt-5-mini';

function isRateLimitError(error: unknown) {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes('429') ||
    message.includes('rate limit') ||
    message.includes('rate-limit') ||
    message.includes('too many requests')
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function parseIndexedTracks(
  albumName: string,
  indexedTracks: Array<{ inputIndex: number; track: TrackInput }>,
) {
  const allArtists = [...new Set(indexedTracks.flatMap(({ track }) => track.artistNames))];
  const artistsText = allArtists.length > 0 ? `\nArtists on album: ${allArtists.join(', ')}` : '';

  const trackList = indexedTracks
    .map(
      ({ inputIndex, track }) =>
        `${inputIndex}. "${track.trackName}"${
          track.artistNames.length > 0 ? ` (${track.artistNames.join(', ')})` : ''
        }`,
    )
    .join('\n');

  const prompt = `Parse these classical music tracks from the album "${albumName}":${artistsText}

${trackList}

Return one object for every input track. Copy each track's numeric prefix into inputIndex. Tracks from the same work should have consistent catalog numbers and formal names. Use the album and track context to disambiguate sparse track titles like "I. Allegro" or "Andante".`;

  if (process.env.CLASSICAL_PARSER_DEBUG === '1') {
    console.log('AI Album Batch Prompt:', prompt);
  }

  let output: z.infer<typeof albumBatchSchema> | undefined;
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await generateText({
        model: PARSER_MODEL,
        prompt,
        output: Output.object({
          schema: albumBatchSchema,
        }),
      });
      output = result.output;
      break;
    } catch (error) {
      const backoffMs = RATE_LIMIT_BACKOFF_MS[attempt];
      if (!isRateLimitError(error) || backoffMs === undefined) throw error;
      console.warn(`AI rate limit; retrying this parse chunk in ${backoffMs / 1000}s.`);
      await sleep(backoffMs);
    }
  }

  if (process.env.CLASSICAL_PARSER_DEBUG === '1') {
    console.log('AI Album Batch Response:', JSON.stringify(output, null, 2));
  }

  return output.tracks;
}

export async function parseAlbumTracks(
  albumName: string,
  tracks: TrackInput[],
): Promise<ClassicalMetadata[]> {
  if (tracks.length === 0) {
    return [];
  }

  const indexedTracks = tracks.map((track, index) => ({ inputIndex: index + 1, track }));
  const parsed: Awaited<ReturnType<typeof parseIndexedTracks>> = [];
  for (let offset = 0; offset < indexedTracks.length; offset += MAX_TRACKS_PER_PARSE) {
    parsed.push(
      ...(await parseIndexedTracks(
        albumName,
        indexedTracks.slice(offset, offset + MAX_TRACKS_PER_PARSE),
      )),
    );
  }
  const parsedByIndex = new Map(
    parsed
      .filter(({ inputIndex }) => inputIndex >= 1 && inputIndex <= tracks.length)
      .map(({ inputIndex, ...metadata }) => [inputIndex, metadata]),
  );

  const missingTracks = indexedTracks.filter(({ inputIndex }) => !parsedByIndex.has(inputIndex));
  for (const missingTrack of missingTracks) {
    const fallback = await parseIndexedTracks(albumName, [missingTrack]);
    const parsedFallback = fallback.find(
      ({ inputIndex }) => inputIndex === missingTrack.inputIndex,
    );
    if (!parsedFallback) {
      throw new Error(`No parsed metadata returned for input track ${missingTrack.inputIndex}`);
    }
    const { inputIndex, ...metadata } = parsedFallback;
    parsedByIndex.set(inputIndex, metadata);
  }

  return indexedTracks.map(({ inputIndex }) => parsedByIndex.get(inputIndex)!);
}
