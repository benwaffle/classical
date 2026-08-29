'use server';

import { parseAlbumTracks as parseAlbumTracksCore } from '@/lib/classical-parser';

export async function parseAlbumTracks(
  albumName: string,
  tracks: Array<{ trackName: string; artistNames: string[] }>,
) {
  return parseAlbumTracksCore(albumName, tracks);
}
