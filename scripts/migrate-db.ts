import { loadEnvConfig } from '@next/env';

async function main() {
  loadEnvConfig(process.cwd());
  if (!process.env.TURSO_DATABASE_URL) {
    throw new Error('TURSO_DATABASE_URL is required');
  }
  const [{ db }, { migrate }] = await Promise.all([
    import('@/lib/db'),
    import('drizzle-orm/libsql/migrator'),
  ]);
  await migrate(db, { migrationsFolder: 'drizzle' });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
