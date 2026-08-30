PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;

-- Preserve a deterministic relative order for non-canonical/alternate K. 626
-- parts while the primary fourteen leaf parts are restored below.
CREATE TEMP TABLE k626_extra_order AS
SELECT
  id,
  row_number() OVER (ORDER BY position, id) + 14 AS new_position
FROM work_part_v2
WHERE work_id = 42
  AND id NOT IN (7151, 7152, 3724, 3725, 3726, 3727, 3728, 3729,
                 7157, 3731, 3732, 3733, 3734, 7155);

UPDATE work_part_v2
SET position = 1000000 + id
WHERE work_id = 42;

UPDATE work_part_v2 SET position = 1,  label = 'I',     title = 'Introitus'             WHERE id = 7151 AND work_id = 42;
UPDATE work_part_v2 SET position = 2,  label = 'II',    title = 'Kyrie'                 WHERE id = 7152 AND work_id = 42;
UPDATE work_part_v2 SET position = 3,  label = 'III.1', title = 'Dies irae'             WHERE id = 3724 AND work_id = 42;
UPDATE work_part_v2 SET position = 4,  label = 'III.2', title = 'Tuba mirum'            WHERE id = 3725 AND work_id = 42;
UPDATE work_part_v2 SET position = 5,  label = 'III.3', title = 'Rex tremendae'         WHERE id = 3726 AND work_id = 42;
UPDATE work_part_v2 SET position = 6,  label = 'III.4', title = 'Recordare'             WHERE id = 3727 AND work_id = 42;
UPDATE work_part_v2 SET position = 7,  label = 'III.5', title = 'Confutatis'            WHERE id = 3728 AND work_id = 42;
UPDATE work_part_v2 SET position = 8,  label = 'III.6', title = 'Lacrimosa'             WHERE id = 3729 AND work_id = 42;
UPDATE work_part_v2 SET position = 9,  label = 'IV.1',  title = 'Domine Jesu Christe'   WHERE id = 7157 AND work_id = 42;
UPDATE work_part_v2 SET position = 10, label = 'IV.2',  title = 'Hostias'                WHERE id = 3731 AND work_id = 42;
UPDATE work_part_v2 SET position = 11, label = 'V',     title = 'Sanctus'                WHERE id = 3732 AND work_id = 42;
UPDATE work_part_v2 SET position = 12, label = 'VI',    title = 'Benedictus'             WHERE id = 3733 AND work_id = 42;
UPDATE work_part_v2 SET position = 13, label = 'VII',   title = 'Agnus Dei'              WHERE id = 3734 AND work_id = 42;
UPDATE work_part_v2 SET position = 14, label = 'VIII',  title = 'Communio'               WHERE id = 7155 AND work_id = 42;

UPDATE work_part_v2
SET position = (SELECT new_position FROM k626_extra_order WHERE id = work_part_v2.id)
WHERE id IN (SELECT id FROM k626_extra_order);

-- Find only exact Cartesian mistakes: an N-track recording where every track
-- is linked to the identical set of N distinct parts.
CREATE TEMP TABLE cartesian_recordings AS
WITH link_stats AS (
  SELECT
    rt.recording_id,
    count(DISTINCT rt.spotify_track_id) AS track_count,
    count(DISTINCT twp.work_part_id) AS part_count,
    count(*) AS link_count
  FROM recording_track_v2 rt
  JOIN recording_v2 r ON r.id = rt.recording_id
  JOIN track_work_part_v2 twp ON twp.spotify_track_id = rt.spotify_track_id
  JOIN work_part_v2 wp ON wp.id = twp.work_part_id AND wp.work_id = r.work_id
  GROUP BY rt.recording_id
)
SELECT recording_id
FROM link_stats
WHERE track_count > 1
  AND track_count = part_count
  AND link_count = track_count * part_count;

CREATE TEMP TABLE cartesian_desired_links AS
WITH ranked_tracks AS (
  SELECT
    rt.recording_id,
    rt.spotify_track_id,
    row_number() OVER (
      PARTITION BY rt.recording_id
      ORDER BY st.disc_number, st.track_number, st.spotify_id
    ) AS part_rank
  FROM recording_track_v2 rt
  JOIN spotify_track st ON st.spotify_id = rt.spotify_track_id
  WHERE rt.recording_id IN (SELECT recording_id FROM cartesian_recordings)
),
distinct_parts AS (
  SELECT DISTINCT rt.recording_id, twp.work_part_id
  FROM recording_track_v2 rt
  JOIN track_work_part_v2 twp ON twp.spotify_track_id = rt.spotify_track_id
  WHERE rt.recording_id IN (SELECT recording_id FROM cartesian_recordings)
),
ranked_parts AS (
  SELECT
    dp.recording_id,
    dp.work_part_id,
    row_number() OVER (
      PARTITION BY dp.recording_id
      ORDER BY wp.position, wp.id
    ) AS part_rank
  FROM distinct_parts dp
  JOIN work_part_v2 wp ON wp.id = dp.work_part_id
)
SELECT t.spotify_track_id, p.work_part_id
FROM ranked_tracks t
JOIN ranked_parts p
  ON p.recording_id = t.recording_id
 AND p.part_rank = t.part_rank;

DELETE FROM track_work_part_v2
WHERE spotify_track_id IN (
  SELECT rt.spotify_track_id
  FROM recording_track_v2 rt
  WHERE rt.recording_id IN (SELECT recording_id FROM cartesian_recordings)
)
AND NOT EXISTS (
  SELECT 1
  FROM cartesian_desired_links desired
  WHERE desired.spotify_track_id = track_work_part_v2.spotify_track_id
    AND desired.work_part_id = track_work_part_v2.work_part_id
);

DROP TABLE cartesian_desired_links;
DROP TABLE cartesian_recordings;
DROP TABLE k626_extra_order;

COMMIT;
