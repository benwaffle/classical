-- Compact fallback parts that were temporarily displaced while canonical parser
-- positions were installed. Preserve their relative legacy movement order.
DROP TABLE IF EXISTS metadata_part_position_repair;
CREATE TABLE metadata_part_position_repair AS
SELECT
  wp.id,
  coalesce((
    SELECT max(canonical.position)
    FROM work_part_v2 canonical
    WHERE canonical.work_id = wp.work_id
      AND canonical.position < 1000000
  ), 0) + row_number() OVER (
    PARTITION BY wp.work_id
    ORDER BY coalesce(m.number, wp.position), wp.id
  ) AS new_position
FROM work_part_v2 wp
LEFT JOIN movement m ON m.id = wp.id
WHERE wp.position >= 1000000;

UPDATE work_part_v2
SET position = (
  SELECT repair.new_position
  FROM metadata_part_position_repair repair
  WHERE repair.id = work_part_v2.id
)
WHERE id IN (SELECT id FROM metadata_part_position_repair);
DROP TABLE metadata_part_position_repair;

-- Reruns and recording reconciliation can leave superseded rows with no
-- memberships. They have no application-visible data and are safe to remove.
DELETE FROM recording_v2
WHERE NOT EXISTS (
  SELECT 1 FROM recording_track_v2 rt WHERE rt.recording_id = recording_v2.id
);

DELETE FROM work_part_v2
WHERE NOT EXISTS (
  SELECT 1 FROM track_work_part_v2 twp WHERE twp.work_part_id = work_part_v2.id
);
