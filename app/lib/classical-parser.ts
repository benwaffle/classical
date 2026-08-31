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

const workPartSchema = z.object({
  position: z.number().int().positive().describe('Canonical leaf-part order within the work'),
  label: z
    .string()
    .nullable()
    .describe(
      "Printed identifier/numbering only, such as 'III', 'III.2', '4', 'Act I', 'No. 4', or 'Variation 18'. Never include a tempo, movement name, form, role, key, or other descriptive words. Null when the source has no identifier.",
    ),
  title: z
    .string()
    .nullable()
    .describe(
      "The complete descriptive leaf title without its identifier, including movement/form words and tempo text, such as 'Menuetto. Allegro molto', 'Tuba mirum', or 'Finale. Allegro brillante'. Null only when no descriptive title is available.",
    ),
});

const classicalMetadataV2Schema = z.object({
  isClassical: z.boolean(),
  composerName: classicalMetadataSchema.shape.composerName,
  formalName: classicalMetadataSchema.shape.formalName,
  nickname: classicalMetadataSchema.shape.nickname,
  catalogSystem: classicalMetadataSchema.shape.catalogSystem,
  catalogNumber: classicalMetadataSchema.shape.catalogNumber,
  form: classicalMetadataSchema.shape.form,
  yearComposed: classicalMetadataSchema.shape.yearComposed,
  recordingGroup: z
    .string()
    .nullable()
    .describe(
      'For every classical track, a non-empty album-local identifier shared only by tracks from the same performance. Null only when isClassical is false',
    ),
  parts: z
    .array(workPartSchema)
    .describe('Zero or more canonical leaf parts performed by this Spotify track'),
});

export type ClassicalMetadataV2 = z.infer<typeof classicalMetadataV2Schema>;

const indexedClassicalMetadataSchema = classicalMetadataSchema.extend({
  inputIndex: z.number().int().positive().describe('The 1-based input track number'),
});

const albumBatchSchema = z.object({
  tracks: z.array(indexedClassicalMetadataSchema),
});

const indexedClassicalMetadataV2Schema = classicalMetadataV2Schema.extend({
  inputIndex: z.number().int().positive(),
});

const albumBatchV2Schema = z.object({ tracks: z.array(indexedClassicalMetadataV2Schema) });

type TrackInput = { trackName: string; artistNames: string[] };
const MAX_TRACKS_PER_PARSE = 20;
const RATE_LIMIT_BACKOFF_MS = [15_000, 30_000, 60_000, 60_000];
const PARSER_MODEL = process.env.CLASSICAL_PARSER_MODEL ?? 'openai/gpt-5-mini';

const CLASSICAL_CLASSIFICATION_RULES = `Set isClassical true only for Western art-music works and their arrangements.
Film, television, and video-game scores or soundtrack cues are not classical merely because they use an orchestra; set isClassical false for them. In particular, Hans Zimmer soundtrack music is not classical for this catalog.`;

const WORK_PART_PARSING_RULES = `A work part is a canonical leaf unit. A Spotify track may contain one leaf, several leaves, or part of one leaf.

For every part, separate its printed identifier from all descriptive text:
- label contains identifier/numbering only: Roman or Arabic numbering, hierarchical numbering, act/scene/no./variation identifiers, etc.
- title contains all descriptive text: movement/form names, liturgical text, dramatic role, tempo, key, and qualifiers.
- Never put words such as Allegro, Adagio, Menuetto, Scherzo, Finale, Prelude, Aria, Chorus, or a key name in label.
- Never copy label into title.
- If there is descriptive text but no printed identifier, label is null.

Required examples:
- "III. Menuetto. Allegro molto e vivace" => label "III"; title "Menuetto. Allegro molto e vivace"
- "III.2. Tuba mirum" => label "III.2"; title "Tuba mirum"
- "4. Largo e spiccato" => label "4"; title "Largo e spiccato"
- "Variation 18 (Andante cantabile)" => label "Variation 18"; title "Andante cantabile"
- "Finale. Allegro brillante" => label null; title "Finale. Allegro brillante"
- "Act I: No. 2. Aria: Adagio" as one leaf => label "Act I: No. 2"; title "Aria: Adagio"
- A track containing "I. Allegro / II. Adagio" => two part objects, not one combined label or title.

"III. Sequentia: 2. Tuba mirum" is its own leaf, distinct from other Sequentia leaves. Preserve its complete structural identifier as label "III.2", not "IV". Hostias is label "IV.2", not "X".

position is the 1-based flattened leaf order across the complete work, not the numeric value of a printed Roman section. In Mozart's Requiem, VIII. Communio follows the six Sequentia leaves and two Offertorium leaves, so it is position 14, not position 8.`;

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

function isRetryableParserError(error: unknown) {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    isRateLimitError(error) ||
    message.includes('gateway request failed') ||
    message.includes('gatewayresponseerror') ||
    message.includes('timeout') ||
    message.includes('timed out') ||
    /\b5\d\d\b/u.test(message)
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

Return one object for every input track. Copy each track's numeric prefix into inputIndex. Tracks from the same work should have consistent catalog numbers and formal names. Use the album and track context to disambiguate sparse track titles like "I. Allegro" or "Andante".

${CLASSICAL_CLASSIFICATION_RULES}`;

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
      if (!isRetryableParserError(error) || backoffMs === undefined) throw error;
      console.warn(`AI gateway retry in ${backoffMs / 1000}s.`);
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

export async function parseAlbumTracksV2(
  albumName: string,
  tracks: Array<TrackInput & { discNumber: number; trackNumber: number }>,
): Promise<ClassicalMetadataV2[]> {
  if (tracks.length === 0) return [];

  const indexedTracks = tracks.map((track, index) => ({ inputIndex: index + 1, track }));
  const parsedByIndex = new Map<number, ClassicalMetadataV2>();
  const albumOutline = indexedTracks
    .map(
      ({ inputIndex, track }) =>
        `${inputIndex}. [disc ${track.discNumber}, track ${track.trackNumber}] "${track.trackName}" (${track.artistNames.join(', ')})`,
    )
    .join('\n');

  for (let offset = 0; offset < indexedTracks.length; offset += MAX_TRACKS_PER_PARSE) {
    const batch = indexedTracks.slice(offset, offset + MAX_TRACKS_PER_PARSE);
    const trackList = batch
      .map(
        ({ inputIndex, track }) =>
          `${inputIndex}. [disc ${track.discNumber}, track ${track.trackNumber}] "${track.trackName}" (${track.artistNames.join(', ')})`,
      )
      .join('\n');
    let output: z.infer<typeof albumBatchV2Schema> | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await generateText({
          model: PARSER_MODEL,
          prompt: `Parse the requested tracks from the album "${albumName}". The complete album outline is provided so recording groups stay stable across batches:\n\n${albumOutline}\n\nReturn objects only for these requested inputs:\n${trackList}\n\n${CLASSICAL_CLASSIFICATION_RULES}\n\n${WORK_PART_PARSING_RULES}\n\nEvery classical track must have a non-empty recordingGroup. Use exactly the same descriptive recordingGroup text anywhere the same performance appears in the album, including across requested batches; base it on work and performers rather than the batch number. Separate performances of the same work require different groups. For a primary composer with a completion or arrangement credit, put only the primary composer in composerName. formalName must identify the complete work represented by the track, not an album collection, excerpt heading, or movement. Copy inputIndex exactly.`,
          output: Output.object({ schema: albumBatchV2Schema }),
        });
        output = result.output;
        if (process.env.CLASSICAL_PARSER_DEBUG === '1') {
          console.log('AI Album V2 Batch Response:', JSON.stringify(output, null, 2));
        }
        break;
      } catch (error) {
        const backoffMs = RATE_LIMIT_BACKOFF_MS[attempt];
        if (!isRetryableParserError(error) || backoffMs === undefined) throw error;
        console.warn(`AI gateway retry in ${backoffMs / 1000}s.`);
        await sleep(backoffMs);
      }
    }
    for (const { inputIndex, ...metadata } of output.tracks) {
      if (inputIndex >= 1 && inputIndex <= tracks.length) parsedByIndex.set(inputIndex, metadata);
    }
  }

  const missing = indexedTracks.filter(({ inputIndex }) => !parsedByIndex.has(inputIndex));
  if (missing.length > 0) {
    throw new Error(
      `No v2 parsed metadata returned for input tracks ${missing.map((t) => t.inputIndex).join(', ')}`,
    );
  }
  return indexedTracks.map(({ inputIndex }) => parsedByIndex.get(inputIndex)!);
}
