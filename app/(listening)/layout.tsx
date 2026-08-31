import { AppShell } from '@/app/components/AppShell';

/**
 * The listening screens share one shell. Keeping it in a layout — rather than
 * inside each page — means the Spotify player, the library and the navbar
 * survive navigation instead of being torn down and reconnected, which would
 * stop whatever is playing.
 */
export default function ListeningLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
