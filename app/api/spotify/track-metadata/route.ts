import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  composer,
  spotifyArtist,
  spotifyAlbum,
  spotifyTrack,
  trackMovement,
  movement,
  work
} from "@/lib/db/schema";
import { eq, inArray } from "drizzle-orm";
import { headers } from "next/headers";

export async function POST(request: Request) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Check if user is benwaffle
  if (session.user.name !== "benwaffle") {
    return Response.json({ error: "Access denied" }, { status: 403 });
  }

  const { trackUri } = await request.json();

  if (!trackUri || typeof trackUri !== "string") {
    return Response.json({ error: "Invalid track URI" }, { status: 400 });
  }

  // Extract track ID from URI (spotify:track:TRACK_ID) or URL (https://open.spotify.com/track/TRACK_ID)
  let trackId: string | null = null;

  // Try URI format first
  const uriMatch = trackUri.match(/spotify:track:([a-zA-Z0-9]+)/);
  if (uriMatch) {
    trackId = uriMatch[1];
  } else {
    // Try URL format
    const urlMatch = trackUri.match(/open\.spotify\.com\/track\/([a-zA-Z0-9]+)/);
    if (urlMatch) {
      trackId = urlMatch[1];
    }
  }

  if (!trackId) {
    return Response.json(
      { error: "Invalid Spotify track URI or URL format" },
      { status: 400 }
    );
  }

  // Get Spotify access token
  const tokenResponse = await auth.api.getAccessToken({
    body: {
      providerId: "spotify",
      userId: session.user.id,
    },
    headers: await headers(),
  });

  if (!tokenResponse?.accessToken) {
    return Response.json({ error: "No Spotify access token" }, { status: 401 });
  }

  // Fetch track metadata from Spotify API
  try {
    const response = await fetch(
      `https://api.spotify.com/v1/tracks/${trackId}`,
      {
        headers: {
          Authorization: `Bearer ${tokenResponse.accessToken}`,
        },
      }
    );

    if (!response.ok) {
      const errorData = await response.json();
      return Response.json(
        { error: errorData.error?.message || "Failed to fetch track from Spotify" },
        { status: response.status }
      );
    }

    const trackData = await response.json();

    // Check if artists, album, and track exist in database
    const artistIds = trackData.artists.map((a: any) => a.id);

    const [existingSpotifyArtists, existingComposers, existingAlbum, existingTrack] = await Promise.all([
      db
        .select()
        .from(spotifyArtist)
        .where(inArray(spotifyArtist.spotifyId, artistIds)),
      db
        .select()
        .from(composer)
        .where(inArray(composer.spotifyArtistId, artistIds)),
      db
        .select()
        .from(spotifyAlbum)
        .where(eq(spotifyAlbum.spotifyId, trackData.album.id)),
      db
        .select()
        .from(spotifyTrack)
        .where(eq(spotifyTrack.spotifyId, trackData.id)),
    ]);

    const spotifyArtistMap = new Map(
      existingSpotifyArtists.map((a) => [a.spotifyId, a])
    );
    const composerMap = new Map(
      existingComposers.map((c) => [c.spotifyArtistId, c])
    );

    // Fetch track movements and related data if track exists
    let trackMovements: any[] = [];
    let movementsData: any[] = [];
    let worksData: any[] = [];
    let composersData: any[] = [];

    if (existingTrack.length > 0) {
      const trackMovementRecords = await db
        .select()
        .from(trackMovement)
        .where(eq(trackMovement.spotifyTrackId, trackData.id));

      if (trackMovementRecords.length > 0) {
        trackMovements = trackMovementRecords;

        const movementIds = trackMovementRecords.map((tm) => tm.movementId);
        movementsData = await db
          .select()
          .from(movement)
          .where(inArray(movement.id, movementIds));

        const workIds = movementsData.map((m) => m.workId);
        if (workIds.length > 0) {
          worksData = await db
            .select()
            .from(work)
            .where(inArray(work.id, workIds));

          const composerIds = worksData.map((w) => w.composerId);
          if (composerIds.length > 0) {
            composersData = await db
              .select()
              .from(composer)
              .where(inArray(composer.id, composerIds));
          }
        }
      }
    }

    return Response.json({
      id: trackData.id,
      name: trackData.name,
      uri: trackData.uri,
      duration_ms: trackData.duration_ms,
      track_number: trackData.track_number,
      popularity: trackData.popularity,
      inSpotifyTracksTable: existingTrack.length > 0,
      artists: trackData.artists.map((artist: any) => ({
        id: artist.id,
        name: artist.name,
        uri: artist.uri,
        inSpotifyArtistsTable: spotifyArtistMap.has(artist.id),
        inComposersTable: composerMap.has(artist.id),
        composerId: composerMap.get(artist.id)?.id,
      })),
      album: {
        id: trackData.album.id,
        name: trackData.album.name,
        uri: trackData.album.uri,
        release_date: trackData.album.release_date,
        popularity: trackData.album.popularity,
        images: trackData.album.images,
        inSpotifyAlbumsTable: existingAlbum.length > 0,
      },
      dbData: {
        track: existingTrack[0] || null,
        album: existingAlbum[0] || null,
        artists: existingSpotifyArtists,
        composers: composersData,
        trackMovements: trackMovements,
        movements: movementsData,
        works: worksData,
      },
    });
  } catch (error) {
    console.error("Error fetching track metadata:", error);
    return Response.json(
      { error: "Failed to fetch track metadata" },
      { status: 500 }
    );
  }
}
