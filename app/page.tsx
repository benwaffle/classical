'use client';

import { AppShell } from './components/AppShell';
import { LibraryScreen } from './components/library/LibraryScreen';

export default function LibraryPage() {
  return (
    <AppShell current="library" searchPlaceholder="Search your library…">
      <LibraryScreen />
    </AppShell>
  );
}
