import { loadEnvConfig } from '@next/env';

function parseOptions(argv: string[]) {
  let albumId: string | undefined;
  let apply = false;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--album') albumId = argv[++index];
    else if (argument === '--apply') apply = true;
    else if (argument === '--help') {
      console.log(`Usage: pnpm metadata:reparse-album --album <spotify-id> [--apply]

Without --apply, this command only displays the selected stored tracks.
Take a production database backup before using --apply.`);
      process.exit(0);
    } else throw new Error(`Unknown option: ${argument}`);
  }
  if (!albumId) throw new Error('--album <spotify-id> is required');
  return { albumId, apply };
}

async function main() {
  loadEnvConfig(process.cwd());
  const options = parseOptions(process.argv.slice(2));
  if (!process.env.TURSO_DATABASE_URL) {
    throw new Error('TURSO_DATABASE_URL is required');
  }

  const [{ db }, schema, drizzle, parser, spotify, writer] = await Promise.all([
    import('@/lib/db'),
    import('@/lib/db/schema'),
    import('drizzle-orm'),
    import('@/lib/classical-parser'),
    import('@/lib/spotify-app-client'),
    import('@/lib/work-parts-v2'),
  ]);
  const { eq } = drizzle;
  const { album, tracks } = await spotify.getSpotifyAlbumTracks(options.albumId);
  const ordered = [...tracks].sort(
    (a, b) => a.disc_number - b.disc_number || a.track_number - b.track_number,
  );
  const storedTracks = await db
    .select({ id: schema.spotifyTrack.spotifyId })
    .from(schema.spotifyTrack)
    .where(eq(schema.spotifyTrack.spotifyAlbumId, options.albumId));
  const storedTrackIds = new Set(storedTracks.map((track) => track.id));
  const selected = ordered.filter((track) => storedTrackIds.has(track.id));

  console.log(`${album.name}: ${selected.length} stored tracks`);
  for (const track of selected) {
    console.log(`  ${track.disc_number}.${track.track_number} ${track.name}`);
  }
  if (!options.apply) {
    console.log('Inspection only; pass --apply after taking a database backup.');
    return;
  }
  if (selected.length === 0) throw new Error('No stored tracks found for this album');

  for (const track of selected) {
    await db
      .update(schema.spotifyTrack)
      .set({ discNumber: track.disc_number, trackNumber: track.track_number })
      .where(eq(schema.spotifyTrack.spotifyId, track.id));
  }
  const parsed = await parser.parseAlbumTracksV2(
    album.name,
    ordered.map((track) => ({
      trackName: track.name,
      artistNames: track.artists.map((artist) => artist.name),
      discNumber: track.disc_number,
      trackNumber: track.track_number,
    })),
  );
  const parsedByTrackId = new Map(ordered.map((track, index) => [track.id, parsed[index]]));
  const result = await writer.saveParsedAlbumV2(
    options.albumId,
    selected.map((track) => ({
      id: track.id,
      discNumber: track.disc_number,
      trackNumber: track.track_number,
    })),
    selected.map((track) => parsedByTrackId.get(track.id)!),
  );
  console.log('Reparse complete:', result);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
