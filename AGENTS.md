# Classical Music Streaming App

We're building a streaming site optimized for classical music that uses spotify as the backend.

It uses NextJS on Vercel for frontend and edge api routes, with Turso Cloud (built on libSQL) as the DB. I aim to minimize the user data we store to the required better-auth tables. The main purpose of the DB is to store classical music metadata.

## Planned Features

- short term
  - understanding of additional metadata, and ability to search & navigate by these
    - catalog sections
    - works identified via catalog numbers, and opus
    - movements
    - recordings
    - nicknames ("Moonlight sonata")
  - Liked songs should be the home page. grouped by catalog number and recording
  - support users who only mark specific movements as 'liked' instead of the whole work
  - sort recordings by spotify popularity field
- long term
  - music discovery features - not sure how yet
  - sheet music integration - IMSLP, musescore

## Use cases

When first opening the app, we open the user's liked songs, and match all spotify track IDs to work+recording.
The tracks that are unmatched will be hidden. The user can see this list separately and submit missing tracks to the matching service. This should be possible for any playlist

The user should be able to click on a track's catalog number to see other recordings, sorted by popularity. Movements in a recording are always displayed together.

The user should be able to click on a track's composer to see popular works.

The user should be able to search for composer or work.

## Don't paper over data issues in the UI

The metadata is incomplete and will stay that way for a while. When the UI meets
a gap, it must **show the gap**, not disguise it. The UI is how we find out what
the pipeline still owes us — hiding a gap costs us that signal and quietly lies
to the reader.

Concretely, don't:

- invent a placeholder that reads like real data (`"Movement 3"`, `"Unknown
  performer"`, an era guessed from a missing birth year)
- silently drop rows we can't render — a work whose recording has no matched
  tracks still belongs in the list, marked
- substitute a proxy for a missing field and present it as the real thing (e.g.
  ranking by recording count while calling it popularity)
- imply an ordering that the data can't support

Instead: leave it blank, or label it as missing/unmatched, and keep the row
visible. Preferring the better of two *real* values (the fullest recording of a
work, the credited artist when the composer is the only artist) is fine — that's
a choice between things we actually know.

Known gaps as of 2026-08-30, all of which the UI should surface rather than mask:

| Gap | Extent |
| --- | --- |
| `recording_v2.popularity` unpopulated | 4924 of 4924 — every "sort by popularity" surface is really unordered |
| recordings with no tracks mapped to movements | 291 |
| `work_part_v2` rows with neither label nor title | 261 |
| works with duplicate parts — the same movement matched twice under different punctuation, e.g. work 1008 has both `VII July. The Reaper's Song` and `7 July: Reaper's Song` | 186 works, 264 redundant rows |
| composers with no `birth_year` (so no derived era) | 290 of 651 |
| works with no `form` (so no catalogue genre) | 109 |
| duplicate works | e.g. Tchaikovsky's Nutcracker as both `Op 71` and `Op 71 (TH 14)` |

## Tools

Use `turso db shell spotify-classical "<query>"` to execute SQL queries

## Tips

- Take a backup of the DB before mutating prod data or schema.
- Short downtime is OK, I'm the only user.
- We're doing CI/CD, so prod deploys are done by landing commits on main