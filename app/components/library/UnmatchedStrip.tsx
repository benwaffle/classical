'use client';

import { useEffect, useState } from 'react';
import { getQueuedTrackIds, submitToMatchQueue } from '@/app/actions/spotify';
import type { UnmatchedTrack } from '@/lib/library-context';

/**
 * Saved tracks we could not place in a work. Deliberately quiet — an escape
 * hatch at the foot of the library, never a section competing for attention.
 */
export function UnmatchedStrip({ tracks }: { tracks: UnmatchedTrack[] }) {
  const [open, setOpen] = useState(false);
  const [queued, setQueued] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState<Set<string>>(new Set());

  // Only ask which of these are already queued once the list is on screen.
  useEffect(() => {
    if (!open || tracks.length === 0) return;
    let cancelled = false;
    getQueuedTrackIds(tracks.map((t) => t.id))
      .then((ids) => {
        if (!cancelled) setQueued((prev) => new Set([...prev, ...ids]));
      })
      .catch((err) => console.error('Failed to read match queue:', err));
    return () => {
      cancelled = true;
    };
  }, [open, tracks]);

  if (tracks.length === 0) return null;
  const left = tracks.length - queued.size;

  const send = async (trackId: string) => {
    setSending((prev) => new Set(prev).add(trackId));
    try {
      await submitToMatchQueue([trackId]);
      setQueued((prev) => new Set(prev).add(trackId));
    } catch (err) {
      console.error('Failed to submit track for matching:', err);
    } finally {
      setSending((prev) => {
        const next = new Set(prev);
        next.delete(trackId);
        return next;
      });
    }
  };

  return (
    <div className="mt-2 border-t border-rule pt-[14px]">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="group flex cursor-pointer items-baseline gap-[9px] font-meta text-[10px] tracking-[0.16em] text-muted uppercase transition-colors duration-150 hover:text-ink-2 max-[900px]:flex-wrap"
      >
        <span className="w-[11px] font-meta text-muted">{open ? '–' : '+'}</span>
        {`${left} ${left === 1 ? 'track' : 'tracks'} we couldn’t identify`}
        <span className="font-display text-[12px] tracking-normal text-rule normal-case italic group-hover:text-muted">
          {open ? 'hide' : 'help us match them'}
        </span>
      </button>

      {open && (
        <div className="mt-[10px]">
          {tracks.map((t) => {
            const done = queued.has(t.id);
            const busy = sending.has(t.id);
            return (
              <div
                key={t.id}
                className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto_150px] items-baseline gap-[14px] py-[7px] max-[900px]:grid-cols-[minmax(0,1fr)_auto] max-[900px]:gap-x-[14px] max-[900px]:gap-y-[2px] max-[900px]:py-2"
              >
                <span
                  className={`truncate font-display text-[14px] text-ink-2 ${done ? 'opacity-50' : ''}`}
                >
                  {t.title}
                </span>
                <span
                  className={`truncate font-display text-[12px] text-muted italic max-[900px]:col-start-1 ${
                    done ? 'opacity-50' : ''
                  }`}
                >
                  {t.artist} · {t.album}
                </span>
                <span className="font-meta text-[10.5px] text-muted tabular-nums max-[900px]:col-start-2 max-[900px]:row-start-1">
                  {t.duration}
                </span>
                <button
                  type="button"
                  disabled={done || busy}
                  onClick={() => send(t.id)}
                  className="cursor-pointer justify-self-end rounded-[2px] border border-rule px-[9px] py-1 font-meta text-[9px] tracking-[0.16em] text-muted uppercase transition-colors duration-150 not-disabled:hover:border-ink-2 not-disabled:hover:text-ink disabled:cursor-default disabled:border-dotted disabled:text-rule max-[900px]:col-start-2 max-[900px]:row-start-2"
                >
                  {done ? 'Queued' : busy ? 'Sending…' : 'Send for matching'}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
