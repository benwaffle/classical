import { useState } from "react";
import Image from "next/image";
import {
  getBatchTrackMetadata,
  addWorkMovementAndTrack,
  addAlbumToDatabase,
  addArtistsToDatabase,
  addTrackToDatabase,
  addComposer,
  deleteTrackMetadata,
  type TrackMetadata,
} from "./actions";
import { parseBatchTrackMetadata, type ClassicalMetadata } from "./parse-track";

interface TrackData extends TrackMetadata {
  parsed?: ClassicalMetadata;
}

interface AlbumTracksTableProps {
  album: {
    id: string;
    name: string;
    release_date: string;
    images: { url: string; width: number; height: number }[];
  };
  initialTracks: TrackData[];
  onError?: (error: string) => void;
  onSuccess?: (message: string) => void;
}

export function AlbumTracksTable({ album, initialTracks, onError, onSuccess }: AlbumTracksTableProps) {
  const [tracks, setTracks] = useState<TrackData[]>(initialTracks);
  const [analyzing, setAnalyzing] = useState(false);
  const [savingTracks, setSavingTracks] = useState<Set<string>>(new Set());

  // Helper to check if track has metadata (linked to work/movement)
  const hasMetadata = (track: TrackData) => {
    return track.dbData?.trackMovements && track.dbData.trackMovements.length > 0;
  };

  // Helper to get composer name (from parsed or DB)
  const getComposerName = (track: TrackData) => {
    return track.parsed?.composerName || track.dbData?.composers[0]?.name || null;
  };

  // Helper to check if composer exists in DB
  const composerExistsInDb = (track: TrackData) => {
    const composerName = getComposerName(track);
    if (!composerName) return false;
    const composerArtist = track.artists.find(a => a.name === composerName);
    return composerArtist?.inComposersTable || false;
  };

  // Helper to get work info (from parsed or DB)
  const getWorkInfo = (track: TrackData): {
    catalogSystem: string | null;
    catalogNumber: string | null;
    nickname: string | null;
    title: string;
  } | null => {
    if (track.parsed) {
      return {
        catalogSystem: track.parsed.catalogSystem,
        catalogNumber: track.parsed.catalogNumber,
        nickname: track.parsed.nickname,
        title: track.parsed.formalName,
      };
    }
    if (track.dbData?.works?.[0]) {
      const w = track.dbData.works[0];
      return {
        catalogSystem: w.catalogSystem,
        catalogNumber: w.catalogNumber,
        nickname: w.nickname,
        title: w.title,
      };
    }
    return null;
  };

  // Helper to check if work exists in DB
  const workExistsInDb = (track: TrackData) => {
    const workInfo = getWorkInfo(track);
    if (!workInfo) return false;
    return track.dbData?.works?.some(w => {
      if (workInfo.catalogSystem && workInfo.catalogNumber) {
        return w.catalogSystem === workInfo.catalogSystem &&
               w.catalogNumber === workInfo.catalogNumber;
      }
      return w.title === workInfo.title;
    }) || false;
  };

  // Helper to get movement info (from parsed or DB)
  const getMovementInfo = (track: TrackData) => {
    if (track.parsed) {
      return {
        number: track.parsed.movement,
        title: track.parsed.movementName,
      };
    }
    if (track.dbData?.movements?.[0]) {
      return track.dbData.movements[0];
    }
    return null;
  };

  // Helper to check if movement exists in DB
  const movementExistsInDb = (track: TrackData) => {
    const movementInfo = getMovementInfo(track);
    if (!movementInfo?.number) return false;
    return track.dbData?.movements?.some(m =>
      m.number === movementInfo.number
    ) || false;
  };

  // Helper to get inferred movement number
  const getInferredMovement = (track: TrackData) => {
    if (!track.parsed || track.parsed.movement) return null;

    const parsed = track.parsed;
    const sameWorkTracks = tracks
      .filter(t => {
        if (t.album.id !== track.album.id) return false;

        const parsedMatch = t.parsed?.catalogSystem === parsed.catalogSystem &&
                           t.parsed?.catalogNumber === parsed.catalogNumber &&
                           t.parsed?.composerName === parsed.composerName;

        const dbMatch = t.dbData?.works?.some(w =>
          w.catalogSystem === parsed.catalogSystem &&
          w.catalogNumber === parsed.catalogNumber
        );

        return parsedMatch || dbMatch;
      })
      .sort((a, b) => a.track_number - b.track_number);

    if (sameWorkTracks.length > 1) {
      const position = sameWorkTracks.findIndex(t => t.id === track.id);
      return position >= 0 ? position + 1 : -1;
    }
    return 1;
  };

  const handleAnalyze = async () => {
    setAnalyzing(true);

    try {
      const unknownTracks = tracks.filter(t => !hasMetadata(t));

      if (unknownTracks.length === 0) {
        onError?.("All tracks in this album are already in the database");
        return;
      }

      const parseInput = unknownTracks.map(t => ({
        trackName: t.name,
        artistNames: t.artists.map(a => a.name),
      }));

      const parsedResults = await parseBatchTrackMetadata(parseInput);

      setTracks(prev => prev.map(track => {
        const unknownIndex = unknownTracks.findIndex(ut => ut.id === track.id);
        if (unknownIndex !== -1) {
          return { ...track, parsed: parsedResults[unknownIndex] };
        }
        return track;
      }));
    } catch (err) {
      onError?.(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setAnalyzing(false);
    }
  };

  const handleSaveTrack = async (track: TrackData) => {
    const composerName = getComposerName(track);
    const workInfo = getWorkInfo(track);
    const movementInfo = getMovementInfo(track);

    if (!composerName || !workInfo) return;

    setSavingTracks(prev => new Set(prev).add(track.id));

    try {
      const composerArtist = track.artists.find(a => a.name === composerName);

      if (!composerArtist) {
        throw new Error(`Could not find composer artist: ${composerName}`);
      }

      if (!track.album.inSpotifyAlbumsTable) {
        await addAlbumToDatabase({
          id: track.album.id,
          name: track.album.name,
          release_date: track.album.release_date,
          popularity: track.album.popularity,
          images: track.album.images,
        });
      }

      const artistsToSave = track.artists.filter(a => !a.inSpotifyArtistsTable);
      if (artistsToSave.length > 0) {
        await addArtistsToDatabase(
          artistsToSave.map(a => ({ id: a.id, name: a.name }))
        );
      }

      let composerId = composerArtist.composerId;
      if (!composerId) {
        const result = await addComposer(composerArtist.id, composerName);
        composerId = result.composer.id;
      }

      if (!track.inSpotifyTracksTable) {
        await addTrackToDatabase({
          id: track.id,
          name: track.name,
          uri: track.uri,
          duration_ms: track.duration_ms,
          track_number: track.track_number,
          popularity: track.popularity,
          albumId: track.album.id,
          artists: track.artists.map(a => ({ id: a.id, name: a.name })),
        });
      }

      let movementNumber = movementInfo?.number;

      if (!movementNumber) {
        const sameWorkTracks = tracks
          .filter(t => {
            if (t.album.id !== track.album.id) return false;

            const parsedMatch = t.parsed?.catalogSystem === workInfo.catalogSystem &&
                               t.parsed?.catalogNumber === workInfo.catalogNumber &&
                               t.parsed?.composerName === composerName;

            const dbMatch = t.dbData?.works?.some(w =>
              w.catalogSystem === workInfo.catalogSystem &&
              w.catalogNumber === workInfo.catalogNumber
            );

            return parsedMatch || dbMatch;
          })
          .sort((a, b) => a.track_number - b.track_number);

        if (sameWorkTracks.length > 1) {
          const position = sameWorkTracks.findIndex(t => t.id === track.id);
          movementNumber = position >= 0 ? position + 1 : -1;
        } else {
          movementNumber = 1;
        }
      }

      await addWorkMovementAndTrack({
        composerId,
        formalName: workInfo.title,
        nickname: workInfo.nickname || null,
        catalogSystem: workInfo.catalogSystem || null,
        catalogNumber: workInfo.catalogNumber || null,
        key: track.parsed?.key || null,
        form: track.parsed?.form || null,
        movementNumber,
        movementName: movementInfo?.title || null,
        yearComposed: track.parsed?.yearComposed || null,
        spotifyTrackId: track.id,
        spotifyAlbumId: track.album.id,
      });

      const updatedTrackData = await getBatchTrackMetadata([track.uri]);
      setTracks(prev => prev.map(t =>
        t.id === track.id ? { ...updatedTrackData[0], parsed: track.parsed } : t
      ));

      onSuccess?.(`Saved: ${track.name}`);
    } catch (err) {
      onError?.(err instanceof Error ? err.message : "An error occurred while saving");
    } finally {
      setSavingTracks(prev => {
        const next = new Set(prev);
        next.delete(track.id);
        return next;
      });
    }
  };

  const handleUnlink = async (track: TrackData) => {
    if (!hasMetadata(track)) return;

    setSavingTracks(prev => new Set(prev).add(track.id));

    try {
      await deleteTrackMetadata(track.id);
      const updatedTrackData = await getBatchTrackMetadata([track.uri]);
      setTracks(prev => prev.map(t =>
        t.id === track.id ? { ...updatedTrackData[0], parsed: track.parsed } : t
      ));

      onSuccess?.(`Unlinked: ${track.name}`);
    } catch (err) {
      onError?.(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setSavingTracks(prev => {
        const next = new Set(prev);
        next.delete(track.id);
        return next;
      });
    }
  };

  const unknownCount = tracks.filter(t => !hasMetadata(t)).length;

  return (
    <div className="rounded-lg border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 overflow-hidden">
      {/* Album header */}
      <div className="flex items-center gap-4 p-4 bg-zinc-100 dark:bg-zinc-800">
        {album.images[0] && (
          <Image
            src={album.images[0].url}
            alt={album.name}
            width={64}
            height={64}
            className="rounded"
          />
        )}
        <div className="flex-1">
          <div className="font-semibold text-black dark:text-white">
            {album.name}
          </div>
          <div className="text-sm text-zinc-600 dark:text-zinc-400">
            {album.release_date?.split('-')[0]} · {tracks.length} track{tracks.length !== 1 ? 's' : ''}
          </div>
        </div>
        {unknownCount > 0 && (
          <button
            onClick={handleAnalyze}
            disabled={analyzing}
            className="px-3 py-1.5 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {analyzing ? "Analyzing..." : `Analyze ${unknownCount}`}
          </button>
        )}
      </div>

      {/* Tracks table */}
      <table className="w-full">
        <thead className="bg-zinc-50 dark:bg-zinc-800/50 text-xs text-zinc-600 dark:text-zinc-400">
          <tr>
            <th className="px-4 py-2 text-left">#</th>
            <th className="px-4 py-2 text-left">Track Name</th>
            <th className="px-4 py-2 text-left">Composer</th>
            <th className="px-4 py-2 text-left">Work</th>
            <th className="px-4 py-2 text-left">Movement</th>
            <th className="px-4 py-2 text-left">Status</th>
            <th className="px-4 py-2 text-right">Actions</th>
          </tr>
        </thead>
        <tbody className="text-sm">
          {tracks.map((track) => (
            <tr key={track.id} className="border-t border-zinc-200 dark:border-zinc-700">
              <td className="px-4 py-3 text-zinc-500">{track.track_number}</td>
              <td className="px-4 py-3">
                <div>
                  <div className="text-black dark:text-white">{track.name}</div>
                  <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                    {track.artists.map((a, idx) => (
                      <span key={a.id}>
                        {idx > 0 && ', '}
                        <span className={
                          getComposerName(track) === a.name
                            ? 'font-semibold text-zinc-700 dark:text-zinc-300'
                            : ''
                        }>
                          {a.name}
                        </span>
                      </span>
                    ))}
                  </div>
                </div>
              </td>
              <td className="px-4 py-3 text-zinc-700 dark:text-zinc-300">
                <div className="flex items-center gap-2">
                  <span>{getComposerName(track) || '-'}</span>
                  {getComposerName(track) && (
                    composerExistsInDb(track) ? (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">
                        ✓
                      </span>
                    ) : (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400">
                        new
                      </span>
                    )
                  )}
                </div>
              </td>
              <td className="px-4 py-3 text-zinc-700 dark:text-zinc-300">
                <div className="flex items-center gap-2">
                  {(() => {
                    const workInfo = getWorkInfo(track);
                    return workInfo ? (
                      <>
                        <span>
                          {workInfo.catalogSystem} {workInfo.catalogNumber}
                          {workInfo.nickname && ` "${workInfo.nickname}"`}
                        </span>
                        {workExistsInDb(track) ? (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">
                            ✓
                          </span>
                        ) : (
                          <span className="text-xs px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400">
                            new
                          </span>
                        )}
                      </>
                    ) : '-';
                  })()}
                </div>
              </td>
              <td className="px-4 py-3 text-zinc-700 dark:text-zinc-300">
                <div className="flex items-center gap-2">
                  {(() => {
                    const inferredMovement = getInferredMovement(track);
                    const movementInfo = getMovementInfo(track);
                    const displayMovement = movementInfo?.number || inferredMovement || '-';
                    const movementTitle = movementInfo?.title;

                    return (
                      <div className="flex flex-col">
                        <div className="flex items-center gap-2">
                          <span>{displayMovement}</span>
                          {(movementInfo || inferredMovement) && (
                            movementExistsInDb(track) ? (
                              <span className="text-xs px-1.5 py-0.5 rounded bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">
                                ✓
                              </span>
                            ) : inferredMovement !== null && !movementInfo?.number ? (
                              <span className="text-xs px-1.5 py-0.5 rounded bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400">
                                inferred
                              </span>
                            ) : (
                              <span className="text-xs px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400">
                                new
                              </span>
                            )
                          )}
                        </div>
                        {movementTitle && (
                          <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                            {movementTitle}
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>
              </td>
              <td className="px-4 py-3">
                {hasMetadata(track) ? (
                  <span className="text-xs px-2 py-1 rounded-full bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">
                    Linked
                  </span>
                ) : (track.parsed || track.dbData?.works?.length) ? (
                  <span className="text-xs px-2 py-1 rounded-full bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400">
                    Ready
                  </span>
                ) : (
                  <span className="text-xs px-2 py-1 rounded-full bg-gray-100 dark:bg-gray-900/30 text-gray-700 dark:text-gray-400">
                    Unknown
                  </span>
                )}
              </td>
              <td className="px-4 py-3 text-right">
                {(track.parsed || getWorkInfo(track)) && !hasMetadata(track) ? (
                  <button
                    onClick={() => handleSaveTrack(track)}
                    disabled={savingTracks.has(track.id)}
                    className="text-xs px-3 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {savingTracks.has(track.id) ? "Saving..." : "Save"}
                  </button>
                ) : hasMetadata(track) ? (
                  <button
                    onClick={() => handleUnlink(track)}
                    disabled={savingTracks.has(track.id)}
                    className="text-xs px-3 py-1 rounded bg-orange-600 text-white hover:bg-orange-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {savingTracks.has(track.id) ? "Unlinking..." : "Unlink"}
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
