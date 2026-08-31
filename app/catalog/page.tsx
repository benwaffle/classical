'use client';

import { AppShell } from '@/app/components/AppShell';
import { CatalogScreen } from '@/app/components/catalog/CatalogScreen';

export default function CatalogPage() {
  return (
    <AppShell current="catalogue" searchPlaceholder="Composer, work, catalogue no.…">
      <CatalogScreen />
    </AppShell>
  );
}
