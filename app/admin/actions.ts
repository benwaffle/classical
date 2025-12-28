"use server";

import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  spotifyArtist,
  spotifyAlbum,
  spotifyTrack,
  trackArtists,
  work,
  movement,
  trackMovement,
} from "@/lib/db/schema";
import { headers } from "next/headers";
import { eq, and } from "drizzle-orm";

async function checkAuth() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    throw new Error("Unauthorized");
  }

  if (session.user.name !== "benwaffle") {
    throw new Error("Access denied");
  }

  return session;
}

async function getSpotifyAccessToken(userId: string) {
  const tokenResponse = await auth.api.getAccessToken({
    body: {
      providerId: "spotify",
      userId,
    },
    headers: await headers(),
  });

  if (!tokenResponse?.accessToken) {
    throw new Error("No Spotify access token");
  }

  return tokenResponse.accessToken;
}

export async function addAlbumToDatabase(albumData: {
  id: string;
  name: string;
  release_date: string;
  popularity: number;
  images: { url: string; width: number; height: number }[];
}) {
  const session = await checkAuth();

  try {
    const accessToken = await getSpotifyAccessToken(session.user.id);

    const year = albumData.release_date
      ? parseInt(albumData.release_date.split("-")[0])
      : null;

    const albumResponse = await fetch(
      `https://api.spotify.com/v1/albums/${albumData.id}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );
    const fullAlbumData = await albumResponse.json();

    await db
      .insert(spotifyAlbum)
      .values({
        spotifyId: albumData.id,
        title: albumData.name,
        year,
        images: albumData.images,
        popularity: fullAlbumData.popularity || null,
      })
      .onConflictDoUpdate({
        target: spotifyAlbum.spotifyId,
        set: {
          title: albumData.name,
          year,
          images: albumData.images,
          popularity: fullAlbumData.popularity || null,
        },
      });

    return {
      success: true,
      message: `Added album "${albumData.name}" to database`,
    };
  } catch (error) {
    console.error("Error adding album to database:", error);
    throw new Error("Failed to add album to database");
  }
}

export async function addArtistsToDatabase(artists: { id: string; name: string }[]) {
  const session = await checkAuth();

  try {
    const accessToken = await getSpotifyAccessToken(session.user.id);

    for (const artist of artists) {
      const artistResponse = await fetch(
        `https://api.spotify.com/v1/artists/${artist.id}`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      );
      const artistData = await artistResponse.json();

      await db
        .insert(spotifyArtist)
        .values({
          spotifyId: artist.id,
          name: artist.name,
          popularity: artistData.popularity || null,
          images: artistData.images || null,
        })
        .onConflictDoUpdate({
          target: spotifyArtist.spotifyId,
          set: {
            name: artist.name,
            popularity: artistData.popularity || null,
            images: artistData.images || null,
          },
        });
    }

    return {
      success: true,
      message: `Added ${artists.length} artist(s) to database`,
    };
  } catch (error) {
    console.error("Error adding artists to database:", error);
    throw new Error("Failed to add artists to database");
  }
}

export async function addTrackToDatabase(trackData: {
  id: string;
  name: string;
  uri: string;
  duration_ms: number;
  track_number: number;
  popularity: number;
  albumId: string;
  artists: { id: string; name: string }[];
}) {
  await checkAuth();

  try {
    await db
      .insert(spotifyTrack)
      .values({
        spotifyId: trackData.id,
        title: trackData.name,
        trackNumber: trackData.track_number,
        durationMs: trackData.duration_ms,
        popularity: trackData.popularity,
        spotifyAlbumId: trackData.albumId,
      })
      .onConflictDoUpdate({
        target: spotifyTrack.spotifyId,
        set: {
          title: trackData.name,
          trackNumber: trackData.track_number,
          durationMs: trackData.duration_ms,
          popularity: trackData.popularity,
          spotifyAlbumId: trackData.albumId,
        },
      });

    // Upsert track-artist relationships
    for (const artist of trackData.artists) {
      await db
        .insert(trackArtists)
        .values({
          spotifyTrackId: trackData.id,
          spotifyArtistId: artist.id,
        })
        .onConflictDoNothing();
    }

    return {
      success: true,
      message: `Added track "${trackData.name}" to database`,
    };
  } catch (error) {
    console.error("Error adding track to database:", error);
    throw new Error("Failed to add track to database");
  }
}

export async function addComposer(spotifyArtistId: string, name: string) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    throw new Error("Unauthorized");
  }

  if (session.user.name !== "benwaffle") {
    throw new Error("Access denied");
  }

  try {
    const { composer } = await import("@/lib/db/schema");

    // Create a slug from the name
    const id = name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .trim();

    await db.insert(composer).values({
      id,
      name,
      spotifyArtistId,
    });

    return {
      success: true,
      composer: {
        id,
        name,
        spotifyArtistId,
      },
    };
  } catch (error) {
    console.error("Error adding composer:", error);
    throw new Error("Failed to add composer");
  }
}

export async function checkWorkAndMovement(
  composerId: string,
  catalogSystem: string,
  catalogNumber: string,
  movementNumber: number
) {
  await checkAuth();

  try {
    // Find work by composer and catalog number
    const works = await db
      .select()
      .from(work)
      .where(
        and(
          eq(work.composerId, composerId),
          eq(work.catalogSystem, catalogSystem),
          eq(work.catalogNumber, catalogNumber)
        )
      );

    const existingWork = works[0] || null;

    if (!existingWork) {
      return {
        workExists: false,
        movementExists: false,
        work: null,
        movement: null,
      };
    }

    // Find movement by work and movement number
    const movements = await db
      .select()
      .from(movement)
      .where(
        and(
          eq(movement.workId, existingWork.id),
          eq(movement.number, movementNumber)
        )
      );

    const existingMovement = movements[0] || null;

    return {
      workExists: true,
      movementExists: !!existingMovement,
      work: existingWork,
      movement: existingMovement,
    };
  } catch (error) {
    console.error("Error checking work and movement:", error);
    throw new Error("Failed to check work and movement");
  }
}

export async function addWorkMovementAndTrack(data: {
  composerId: string;
  formalName: string;
  nickname: string | null;
  catalogSystem: string;
  catalogNumber: string;
  key: string | null;
  form: string | null;
  movementNumber: number;
  movementName: string | null;
  yearComposed: number | null;
  spotifyTrackId: string;
}) {
  await checkAuth();

  try {
    // Create work ID slug
    const workId = `${data.composerId}/${data.catalogSystem.toLowerCase()}-${data.catalogNumber}`;

    // Upsert work
    await db
      .insert(work)
      .values({
        id: workId,
        composerId: data.composerId,
        title: data.formalName,
        nickname: data.nickname,
        catalogSystem: data.catalogSystem,
        catalogNumber: data.catalogNumber,
        yearComposed: data.yearComposed,
        form: data.form,
      })
      .onConflictDoUpdate({
        target: work.id,
        set: {
          title: data.formalName,
          nickname: data.nickname,
          catalogSystem: data.catalogSystem,
          catalogNumber: data.catalogNumber,
          yearComposed: data.yearComposed,
          form: data.form,
        },
      });

    // Create movement ID
    const movementId = `${workId}/${data.movementNumber}`;

    // Upsert movement
    await db
      .insert(movement)
      .values({
        id: movementId,
        workId,
        number: data.movementNumber,
        title: data.movementName,
      })
      .onConflictDoUpdate({
        target: movement.id,
        set: {
          number: data.movementNumber,
          title: data.movementName,
        },
      });

    // Upsert track-movement relationship
    await db
      .insert(trackMovement)
      .values({
        spotifyTrackId: data.spotifyTrackId,
        movementId,
        startMs: null,
        endMs: null,
      })
      .onConflictDoNothing();

    return {
      success: true,
      message: `Added work "${data.formalName}", movement ${data.movementNumber}, and linked to track`,
      workId,
      movementId,
    };
  } catch (error) {
    console.error("Error adding work, movement, and track:", error);
    throw new Error("Failed to add work, movement, and track");
  }
}
