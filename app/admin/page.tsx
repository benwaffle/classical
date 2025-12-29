"use client";

import { authClient } from "@/lib/auth-client";
import { useState } from "react";
import { getBatchTrackMetadata, type TrackMetadata } from "./actions";
import { AlbumTracksTable } from "./AlbumTracksTable";

interface AlbumGroup {
  album: {
    id: string;
    name: string;
    release_date: string;
    images: { url: string; width: number; height: number }[];
  };
  tracks: TrackMetadata[];
}

export default function AdminPageNew() {
  const { data: session } = authClient.useSession();
  const [trackUrisInput, setTrackUrisInput] = useState("");
  const [albumGroups, setAlbumGroups] = useState<AlbumGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const isAdmin = session?.user?.name === "benwaffle";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const uris = trackUrisInput
        .trim()
        .split('\n')
        .filter(line => line.trim());

      if (uris.length === 0) {
        setError("Please enter at least one Spotify track URI or URL");
        setLoading(false);
        return;
      }

      const trackData = await getBatchTrackMetadata(uris);

      // Group tracks by album
      const grouped = trackData.reduce((acc, track) => {
        const albumId = track.album.id;
        if (!acc[albumId]) {
          acc[albumId] = {
            album: {
              id: track.album.id,
              name: track.album.name,
              release_date: track.album.release_date,
              images: track.album.images,
            },
            tracks: [],
          };
        }
        acc[albumId].tracks.push(track);
        return acc;
      }, {} as Record<string, AlbumGroup>);

      setAlbumGroups(Object.values(grouped));
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setLoading(false);
    }
  };

  if (!session) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-black">
        <p className="text-lg text-zinc-600 dark:text-zinc-400">
          Please sign in to access this page
        </p>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-black">
        <p className="text-lg text-zinc-600 dark:text-zinc-400">
          Access denied
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-black p-8">
      <main className="max-w-7xl mx-auto">
        <h1 className="text-4xl font-bold text-black dark:text-zinc-50 mb-8">
          Admin - Batch Track Metadata
        </h1>

        <form onSubmit={handleSubmit} className="mb-8">
          <div className="flex flex-col gap-2 mb-4">
            <label
              htmlFor="trackUris"
              className="text-sm font-medium text-zinc-700 dark:text-zinc-300"
            >
              Spotify Track URI(s) or URL(s) (one per line)
            </label>
            <textarea
              id="trackUris"
              value={trackUrisInput}
              onChange={(e) => setTrackUrisInput(e.target.value)}
              placeholder="spotify:track:... or https://open.spotify.com/track/...&#10;One URI/URL per line"
              className="rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-4 py-2 text-black dark:text-white min-h-[150px]"
              required
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="px-6 py-3 rounded-lg bg-black text-white hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200 disabled:opacity-50"
          >
            {loading ? "Loading..." : "Load Tracks"}
          </button>
        </form>

        {error && (
          <div className="mb-4 rounded-lg border border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20 px-4 py-3 text-red-700 dark:text-red-300">
            {error}
          </div>
        )}

        {successMessage && (
          <div className="mb-4 rounded-lg border border-green-300 dark:border-green-700 bg-green-50 dark:bg-green-900/20 px-4 py-3 text-green-700 dark:text-green-300">
            {successMessage}
          </div>
        )}

        {albumGroups.length > 0 && (
          <>
            {/* Albums with tracks */}
            <div className="space-y-6">
              {albumGroups.map(({ album, tracks }) => (
                <AlbumTracksTable
                  key={album.id}
                  album={album}
                  initialTracks={tracks}
                  onError={setError}
                  onSuccess={setSuccessMessage}
                />
              ))}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
