'use client';

import { use } from 'react';
import { AppShell } from '@/app/components/AppShell';
import { DetailScreen } from '@/app/components/detail/DetailScreen';

export default function WorkDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ workId: string }>;
  searchParams: Promise<{ rec?: string }>;
}) {
  const { workId } = use(params);
  const { rec } = use(searchParams);

  const id = Number(workId);
  const recordingId = rec !== undefined && rec !== '' ? Number(rec) : null;

  return (
    <AppShell current="library" searchPlaceholder="Search your library…">
      {Number.isFinite(id) ? (
        <DetailScreen
          workId={id}
          recordingId={recordingId !== null && Number.isFinite(recordingId) ? recordingId : null}
        />
      ) : (
        <main className="mx-auto max-w-[1280px] px-6 pt-16">
          <p className="font-display text-[15px] text-muted italic">That isn’t a work we hold.</p>
        </main>
      )}
    </AppShell>
  );
}
