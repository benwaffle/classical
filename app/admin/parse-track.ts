'use server';

import { parseAlbumTracks as parseAlbumTracksCore } from '@/lib/classical-parser';
import { checkAuth } from '@/app/admin/actions/auth';

export async function parseAlbumTracks(
  albumName: string,
  tracks: Array<{ trackName: string; artistNames: string[] }>,
) {
  await checkAuth();
  return parseAlbumTracksCore(albumName, tracks);
}
