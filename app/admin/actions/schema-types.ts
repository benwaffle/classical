import type { InferSelectModel } from 'drizzle-orm';
import {
  composer,
  spotifyArtist,
  spotifyAlbum,
  spotifyTrack,
  work,
  workPartV2,
  trackWorkPartV2,
  recordingV2,
} from '@/lib/db/schema';

export type SpotifyTrackRow = InferSelectModel<typeof spotifyTrack>;
export type SpotifyAlbumRow = InferSelectModel<typeof spotifyAlbum>;
export type SpotifyArtistRow = InferSelectModel<typeof spotifyArtist>;
export type ComposerRow = InferSelectModel<typeof composer>;
export type WorkRow = InferSelectModel<typeof work>;
export type MovementRow = InferSelectModel<typeof workPartV2> & { number: number };
export type TrackMovementRow = {
  spotifyTrackId: string;
  movementId: number;
  startMs: number | null;
  endMs: number | null;
};
export type RecordingRow = InferSelectModel<typeof recordingV2>;
export type WorkPartV2Row = InferSelectModel<typeof workPartV2>;
export type TrackWorkPartV2Row = InferSelectModel<typeof trackWorkPartV2>;
export type RecordingV2Row = InferSelectModel<typeof recordingV2>;
