import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { composer } from "@/lib/db/schema";
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

  const { spotifyArtistId, name } = await request.json();

  if (!spotifyArtistId || !name) {
    return Response.json(
      { error: "Missing required fields" },
      { status: 400 }
    );
  }

  try {
    // Create a slug from the name (lowercase, replace spaces with hyphens, remove special chars)
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

    return Response.json({
      success: true,
      composer: {
        id,
        name,
        spotifyArtistId,
      },
    });
  } catch (error) {
    console.error("Error adding composer:", error);
    return Response.json(
      { error: "Failed to add composer" },
      { status: 500 }
    );
  }
}
