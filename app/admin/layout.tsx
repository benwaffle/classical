import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'admin',
};

/* Admin keeps its own plain surface — the editorial theme is for the
   listening screens. */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-zinc-50 font-sans dark:bg-black">{children}</div>;
}
