"use client";

import { useRef, useEffect, useCallback } from "react";
import Image from "next/image";
import { useSpotifyPlayer } from "@/lib/spotify-player-context";

function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function SpotifyPlayer() {
  const { isReady, isPaused, currentTrack, togglePlay, getProgress } = useSpotifyPlayer();

  // Refs for imperative progress updates
  const progressBarRef = useRef<HTMLDivElement>(null);
  const currentTimeRef = useRef<HTMLSpanElement>(null);
  const durationRef = useRef<HTMLSpanElement>(null);

  // Update progress bar imperatively via requestAnimationFrame
  const updateProgress = useCallback(() => {
    const progress = getProgress();
    if (progressBarRef.current) {
      const percent = progress.duration > 0 ? (progress.position / progress.duration) * 100 : 0;
      progressBarRef.current.style.width = `${percent}%`;
    }
    if (currentTimeRef.current) {
      currentTimeRef.current.textContent = formatTime(progress.position);
    }
    if (durationRef.current) {
      durationRef.current.textContent = formatTime(progress.duration);
    }
  }, [getProgress]);

  useEffect(() => {
    let animationId: number;
    const tick = () => {
      updateProgress();
      animationId = requestAnimationFrame(tick);
    };
    animationId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animationId);
  }, [updateProgress]);

  return (
    <div className="fixed bottom-0 left-0 right-0 bg-zinc-900 border-t border-zinc-800 p-4">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center gap-4 mb-2">
          {currentTrack ? (
            <>
              {currentTrack.album?.images?.[0]?.url && (
                <Image
                  src={currentTrack.album.images[0].url}
                  alt={currentTrack.album?.name || "Album"}
                  width={56}
                  height={56}
                  className="rounded"
                />
              )}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-white truncate">
                  {currentTrack.name}
                </p>
                <p className="text-xs text-zinc-400 truncate">
                  {currentTrack.artists?.map((a) => a.name).join(", ")}
                </p>
              </div>
              <button
                onClick={togglePlay}
                disabled={!isReady}
                className="w-10 h-10 flex items-center justify-center rounded-full bg-white text-black hover:scale-105 transition-transform disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
              >
                {isPaused ? (
                  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                    <path d="M6.3 2.841A1.5 1.5 0 004 4.11V15.89a1.5 1.5 0 002.3 1.269l9.344-5.89a1.5 1.5 0 000-2.538L6.3 2.84z" />
                  </svg>
                ) : (
                  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                    <path d="M5.75 3a.75.75 0 00-.75.75v12.5c0 .414.336.75.75.75h1.5a.75.75 0 00.75-.75V3.75A.75.75 0 007.25 3h-1.5zM12.75 3a.75.75 0 00-.75.75v12.5c0 .414.336.75.75.75h1.5a.75.75 0 00.75-.75V3.75a.75.75 0 00-.75-.75h-1.5z" />
                  </svg>
                )}
              </button>
            </>
          ) : (
            <div className="flex-1">
              <p className="text-sm text-zinc-400">
                {isReady ? "Select a track to play" : "Initializing player..."}
              </p>
            </div>
          )}
        </div>
        {currentTrack && (
          <div className="flex items-center gap-2">
            <span
              ref={currentTimeRef}
              className="text-xs text-zinc-400 w-10 text-right"
            >
              0:00
            </span>
            <div className="flex-1 h-1 bg-zinc-700 rounded-full overflow-hidden">
              <div
                ref={progressBarRef}
                className="h-full bg-white"
                style={{ width: "0%" }}
              />
            </div>
            <span ref={durationRef} className="text-xs text-zinc-400 w-10">
              0:00
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
