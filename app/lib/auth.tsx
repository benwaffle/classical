import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { db } from './db';

/*
 * Spotify only accepts the loopback IP in a redirect URI, so BETTER_AUTH_URL
 * is http://127.0.0.1:3000 — but the dev server answers on localhost too, and
 * Better Auth counts the two as different origins. Without this, signing in
 * from localhost fails with "Invalid origin" while 127.0.0.1 works, which
 * reads as a flaky login rather than a hostname mismatch.
 */
const LOOPBACK_ORIGINS = ['http://127.0.0.1:3000', 'http://localhost:3000'];

export const auth = betterAuth({
  trustedOrigins: process.env.NODE_ENV === 'production' ? [] : LOOPBACK_ORIGINS,
  database: drizzleAdapter(db, {
    provider: 'sqlite',
  }),
  socialProviders: {
    spotify: {
      clientId: process.env.SPOTIFY_CLIENT_ID!,
      clientSecret: process.env.SPOTIFY_CLIENT_SECRET!,
      scope: [
        'user-read-email',
        'user-read-private',
        'user-library-read',
        // The library and detail screens like and unlike individual movements.
        'user-library-modify',
        'user-top-read',
        'playlist-read-private',
        'playlist-read-collaborative',
        'streaming',
        'user-read-playback-state',
        'user-modify-playback-state',
      ],
    },
  },
});
