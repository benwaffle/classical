-- Restore any fallback link removed by an incomplete or unresolved parser result.
INSERT OR IGNORE INTO track_work_part_v2 (
  spotify_track_id,
  work_part_id,
  start_ms,
  end_ms,
  match_source,
  match_status
)
SELECT
  tm.spotify_track_id,
  tm.movement_id,
  tm.start_ms,
  tm.end_ms,
  'migrated',
  'needs_review'
FROM track_movement tm
WHERE NOT EXISTS (
  SELECT 1 FROM track_work_part_v2 twp
  WHERE twp.spotify_track_id = tm.spotify_track_id
);

-- Materialize the unambiguous work for each candidate track. Tracks linked to
-- parts from more than one work are intentionally excluded for manual review.
DROP TABLE IF EXISTS metadata_track_work_repair;
CREATE TABLE metadata_track_work_repair AS
SELECT twp.spotify_track_id, min(wp.work_id) AS work_id
FROM track_work_part_v2 twp
JOIN work_part_v2 wp ON wp.id = twp.work_part_id
GROUP BY twp.spotify_track_id
HAVING count(DISTINCT wp.work_id) = 1;
CREATE UNIQUE INDEX metadata_track_work_repair_track_idx
  ON metadata_track_work_repair (spotify_track_id);

-- Ensure every album/work pair needed by an unambiguous track has at least one
-- recording candidate.
INSERT INTO recording_v2 (spotify_album_id, work_id, popularity)
SELECT DISTINCT st.spotify_album_id, desired.work_id, NULL
FROM metadata_track_work_repair desired
JOIN spotify_track st ON st.spotify_id = desired.spotify_track_id
WHERE NOT EXISTS (
  SELECT 1 FROM recording_v2 r
  WHERE r.spotify_album_id = st.spotify_album_id
    AND r.work_id = desired.work_id
);

-- Remove only absent/mismatched memberships. Confirmed memberships for albums
-- containing several recordings of one work remain untouched.
DELETE FROM recording_track_v2
WHERE spotify_track_id IN (
  SELECT desired.spotify_track_id
  FROM metadata_track_work_repair desired
  LEFT JOIN recording_track_v2 rt ON rt.spotify_track_id = desired.spotify_track_id
  LEFT JOIN recording_v2 current_recording ON current_recording.id = rt.recording_id
  WHERE rt.spotify_track_id IS NULL OR current_recording.work_id <> desired.work_id
);

-- Attach repaired tracks to the closest existing recording of the same
-- album/work. Track order supplies the deterministic tie-breaker.
INSERT INTO recording_track_v2 (recording_id, spotify_track_id, position)
SELECT
  (
    SELECT candidate.id
    FROM recording_v2 candidate
    WHERE candidate.spotify_album_id = st.spotify_album_id
      AND candidate.work_id = desired.work_id
    ORDER BY
      (SELECT count(*) FROM recording_track_v2 member
       WHERE member.recording_id = candidate.id) DESC,
      candidate.id
    LIMIT 1
  ),
  desired.spotify_track_id,
  1000000 + row_number() OVER (ORDER BY desired.spotify_track_id)
FROM metadata_track_work_repair desired
JOIN spotify_track st ON st.spotify_id = desired.spotify_track_id
LEFT JOIN recording_track_v2 rt ON rt.spotify_track_id = desired.spotify_track_id
WHERE rt.spotify_track_id IS NULL;

-- Rebuild every recording position from persisted disc/track order, avoiding
-- transient unique-position collisions during renumbering.
DROP TABLE IF EXISTS metadata_recording_track_rebuild;
CREATE TABLE metadata_recording_track_rebuild AS
SELECT
  rt.recording_id,
  rt.spotify_track_id,
  row_number() OVER (
    PARTITION BY rt.recording_id
    ORDER BY st.disc_number, st.track_number, st.spotify_id
  ) AS position
FROM recording_track_v2 rt
JOIN spotify_track st ON st.spotify_id = rt.spotify_track_id;
DELETE FROM recording_track_v2;
INSERT INTO recording_track_v2 (recording_id, spotify_track_id, position)
SELECT recording_id, spotify_track_id, position
FROM metadata_recording_track_rebuild;

DROP TABLE metadata_recording_track_rebuild;
DROP TABLE metadata_track_work_repair;
