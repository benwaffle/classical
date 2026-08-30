import { runMatchQueueWorker } from '@/lib/match-queue-processor';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || request.headers.get('authorization') !== `Bearer ${cronSecret}`) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const result = await runMatchQueueWorker({
    maxAlbums: 3,
    recover: true,
    retryFailed: true,
    staleMinutes: 30,
  });

  return Response.json(result);
}
