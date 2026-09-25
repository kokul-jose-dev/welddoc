-- 02_health_check.sql  (READ-ONLY)
-- Measures data damage: broken welds, one-directional connections, duplicates, NULL flags,
-- mismatched welder names and unparseable dates. Run it on production to see how much repair
-- the migrations need, and again after each change as a regression check.
--
--   weldoc\venv\Scripts\python db\run_check.py db\checks\02_health_check.sql
-- ============================================================================================

SET NOCOUNT ON;

-- Active pipeline materials, with a wire flag (wires are never connected / welded)
IF OBJECT_ID('tempdb..#m') IS NOT NULL DROP TABLE #m;
SELECT pm.id, pm.pipeline_id, pm.position,
       CASE WHEN LOWER(LTRIM(RTRIM(ISNULL(gm.category, '')))) = 'welding wire' THEN 1 ELSE 0 END AS is_wire
INTO #m
FROM weldoc_pipeline_materials pm
LEFT JOIN weldoc_project_materials prm ON prm.id = pm.project_material_id
LEFT JOIN weldoc_global_materials gm ON gm.id = prm.global_material_id
WHERE pm.archived = 0;

-- Connected pairs (either direction), normalised to lo < hi, same pipeline, non-wire
IF OBJECT_ID('tempdb..#conn_pairs') IS NOT NULL DROP TABLE #conn_pairs;
SELECT DISTINCT s.pipeline_id,
       CASE WHEN s.id < t.id THEN s.id ELSE t.id END AS lo,
       CASE WHEN s.id < t.id THEN t.id ELSE s.id END AS hi
INTO #conn_pairs
FROM weldoc_pipeline_material_connections c
JOIN #m s ON s.id = c.pipeline_material_id
JOIN #m t ON t.id = c.connected_id
WHERE s.pipeline_id = t.pipeline_id AND s.is_wire = 0 AND t.is_wire = 0 AND s.id <> t.id;

-- Active welds resolved from letters to material ids (this is exactly what the Step 3 backfill will do)
IF OBJECT_ID('tempdb..#weld_res') IS NOT NULL DROP TABLE #weld_res;
SELECT w.id AS weld_id, w.pipeline_id, w.weld_no, w.between_a, w.between_b,
       w.welder_id, w.inspector_id, w.date, w.visual, w.endoscopy,
       a.id AS mat_a_id, b.id AS mat_b_id,
       (SELECT COUNT(*) FROM #m x WHERE x.pipeline_id = w.pipeline_id AND x.position = w.between_a) AS a_matches,
       (SELECT COUNT(*) FROM #m x WHERE x.pipeline_id = w.pipeline_id AND x.position = w.between_b) AS b_matches,
       CASE WHEN w.welder_id IS NOT NULL OR w.inspector_id IS NOT NULL
              OR ISNULL(w.date, '') <> '' OR ISNULL(w.visual, '') NOT IN ('', 'n/a')
              OR ISNULL(w.endoscopy, '') NOT IN ('', 'n/a')
            THEN 1 ELSE 0 END AS has_work
INTO #weld_res
FROM weldoc_welds w
OUTER APPLY (SELECT TOP 1 id FROM #m x WHERE x.pipeline_id = w.pipeline_id AND x.position = w.between_a ORDER BY id) a
OUTER APPLY (SELECT TOP 1 id FROM #m x WHERE x.pipeline_id = w.pipeline_id AND x.position = w.between_b ORDER BY id) b
WHERE w.archived = 0;


-- ============================================================================================
-- A. PER-PIPELINE SUMMARY  (the headline number: how many pipelines are damaged)
-- ============================================================================================
SELECT p.id AS pipeline_id, p.no, p.project_id, p.archived,
       (SELECT COUNT(*) FROM #m WHERE pipeline_id = p.id)                                         AS materials,
       (SELECT COUNT(*) FROM #weld_res WHERE pipeline_id = p.id)                                  AS welds,
       -- welds whose letters do not point at exactly one active material
       (SELECT COUNT(*) FROM #weld_res WHERE pipeline_id = p.id
            AND (a_matches <> 1 OR b_matches <> 1))                                               AS welds_unresolvable,
       -- welds that resolve, but the two materials are NOT connected (likely rewired to the wrong material)
       (SELECT COUNT(*) FROM #weld_res r WHERE r.pipeline_id = p.id AND r.a_matches = 1 AND r.b_matches = 1
            AND NOT EXISTS (SELECT 1 FROM #conn_pairs c WHERE c.pipeline_id = r.pipeline_id
                  AND c.lo = CASE WHEN r.mat_a_id < r.mat_b_id THEN r.mat_a_id ELSE r.mat_b_id END
                  AND c.hi = CASE WHEN r.mat_a_id < r.mat_b_id THEN r.mat_b_id ELSE r.mat_a_id END)) AS welds_not_on_connection,
       -- connections that have no weld
       (SELECT COUNT(*) FROM #conn_pairs c WHERE c.pipeline_id = p.id
            AND NOT EXISTS (SELECT 1 FROM #weld_res r WHERE r.pipeline_id = c.pipeline_id
                  AND c.lo = CASE WHEN r.mat_a_id < r.mat_b_id THEN r.mat_a_id ELSE r.mat_b_id END
                  AND c.hi = CASE WHEN r.mat_a_id < r.mat_b_id THEN r.mat_b_id ELSE r.mat_a_id END)) AS connections_without_weld,
       -- duplicate active position letters
       (SELECT COUNT(*) FROM (SELECT position FROM #m WHERE pipeline_id = p.id AND position IS NOT NULL
            GROUP BY position HAVING COUNT(*) > 1) d)                                             AS duplicate_positions,
       -- duplicate weld numbers
       (SELECT COUNT(*) FROM (SELECT weld_no FROM #weld_res WHERE pipeline_id = p.id
            GROUP BY weld_no HAVING COUNT(*) > 1) d)                                              AS duplicate_weld_nos
INTO #summary
FROM weldoc_pipelines p;

SELECT * FROM #summary
WHERE welds_unresolvable + welds_not_on_connection + connections_without_weld
      + duplicate_positions + duplicate_weld_nos > 0
ORDER BY archived, pipeline_id;

SELECT COUNT(*) AS pipelines_total,
       SUM(CASE WHEN welds_unresolvable + welds_not_on_connection + connections_without_weld
                     + duplicate_positions + duplicate_weld_nos > 0 THEN 1 ELSE 0 END) AS pipelines_damaged,
       SUM(welds_unresolvable)       AS welds_unresolvable,
       SUM(welds_not_on_connection)  AS welds_not_on_connection,
       SUM(connections_without_weld) AS connections_without_weld
FROM #summary;


-- ============================================================================================
-- B. DETAIL: welds that carry recorded work and are broken  (these need manual repair first)
-- ============================================================================================
SELECT r.*
FROM #weld_res r
WHERE r.has_work = 1
  AND (r.a_matches <> 1 OR r.b_matches <> 1
       OR NOT EXISTS (SELECT 1 FROM #conn_pairs c WHERE c.pipeline_id = r.pipeline_id
             AND c.lo = CASE WHEN r.mat_a_id < r.mat_b_id THEN r.mat_a_id ELSE r.mat_b_id END
             AND c.hi = CASE WHEN r.mat_a_id < r.mat_b_id THEN r.mat_b_id ELSE r.mat_a_id END))
ORDER BY r.pipeline_id, r.weld_no;


-- ============================================================================================
-- C. CONNECTION TABLE integrity
-- ============================================================================================
-- C1. One-directional rows (A->B stored, B->A missing)
SELECT c.pipeline_material_id, c.connected_id
FROM weldoc_pipeline_material_connections c
WHERE NOT EXISTS (SELECT 1 FROM weldoc_pipeline_material_connections r
                  WHERE r.pipeline_material_id = c.connected_id AND r.connected_id = c.pipeline_material_id);

-- C2. Connections that cross pipelines, touch archived materials, or are self-links
SELECT c.pipeline_material_id, c.connected_id,
       s.pipeline_id AS src_pipeline, t.pipeline_id AS dst_pipeline,
       s.archived AS src_archived, t.archived AS dst_archived
FROM weldoc_pipeline_material_connections c
JOIN weldoc_pipeline_materials s ON s.id = c.pipeline_material_id
JOIN weldoc_pipeline_materials t ON t.id = c.connected_id
WHERE s.pipeline_id <> t.pipeline_id OR s.archived = 1 OR t.archived = 1 OR s.id = t.id;


-- ============================================================================================
-- D. DUPLICATES that would block the planned UNIQUE indexes
-- ============================================================================================
-- D1. Pipeline number repeated inside one project
SELECT project_id, LOWER(LTRIM(RTRIM(no))) AS no_norm, COUNT(*) AS n
FROM weldoc_pipelines WHERE archived = 0
GROUP BY project_id, LOWER(LTRIM(RTRIM(no))) HAVING COUNT(*) > 1;

-- D2. Same project material (project + global material + cert + heat) twice
SELECT project_id, global_material_id,
       LOWER(LTRIM(RTRIM(ISNULL(certificate, '')))) AS cert, LOWER(LTRIM(RTRIM(ISNULL(heat_no, '')))) AS heat,
       COUNT(*) AS n
FROM weldoc_project_materials WHERE archived = 0
GROUP BY project_id, global_material_id,
         LOWER(LTRIM(RTRIM(ISNULL(certificate, '')))), LOWER(LTRIM(RTRIM(ISNULL(heat_no, ''))))
HAVING COUNT(*) > 1;

-- D3. Active project materials pointing at an ARCHIVED global material (left over from merges)
SELECT prm.id, prm.project_id, prm.global_material_id
FROM weldoc_project_materials prm
JOIN weldoc_global_materials gm ON gm.id = prm.global_material_id
WHERE prm.archived = 0 AND gm.archived = 1;

-- D4. Active pipeline materials pointing at an ARCHIVED project material
SELECT pm.id, pm.pipeline_id, pm.project_material_id
FROM weldoc_pipeline_materials pm
JOIN weldoc_project_materials prm ON prm.id = pm.project_material_id
WHERE pm.archived = 0 AND prm.archived = 1;


-- ============================================================================================
-- E. NULL flags (rows that are invisible in both the active and the archived view)
-- ============================================================================================
SELECT 'clients' AS tbl, COUNT(*) AS null_archived FROM weldoc_clients WHERE archived IS NULL
UNION ALL SELECT 'projects',           COUNT(*) FROM weldoc_projects           WHERE archived IS NULL
UNION ALL SELECT 'pipelines',          COUNT(*) FROM weldoc_pipelines          WHERE archived IS NULL
UNION ALL SELECT 'global_materials',   COUNT(*) FROM weldoc_global_materials   WHERE archived IS NULL
UNION ALL SELECT 'project_materials',  COUNT(*) FROM weldoc_project_materials  WHERE archived IS NULL
UNION ALL SELECT 'pipeline_materials', COUNT(*) FROM weldoc_pipeline_materials WHERE archived IS NULL
UNION ALL SELECT 'welds',              COUNT(*) FROM weldoc_welds              WHERE archived IS NULL
UNION ALL SELECT 'welders',            COUNT(*) FROM weldoc_welders            WHERE archived IS NULL
UNION ALL SELECT 'weldercertificate',  COUNT(*) FROM weldoc_weldercertificate  WHERE archived IS NULL;


-- ============================================================================================
-- F. LEGACY name strings disagreeing with the welder/inspector id on a weld
-- ============================================================================================
SELECT w.id, w.pipeline_id, w.weld_no, w.welder, wl.name AS welder_by_id, w.inspector, ins.name AS inspector_by_id
FROM weldoc_welds w
LEFT JOIN weldoc_welders wl  ON wl.id  = w.welder_id
LEFT JOIN weldoc_welders ins ON ins.id = w.inspector_id
WHERE w.archived = 0
  AND (   (w.welder_id IS NOT NULL    AND ISNULL(w.welder, '')    <> '' AND LTRIM(RTRIM(w.welder))    <> LTRIM(RTRIM(wl.name)))
       OR (w.inspector_id IS NOT NULL AND ISNULL(w.inspector, '') <> '' AND LTRIM(RTRIM(w.inspector)) <> LTRIM(RTRIM(ins.name)))
       OR (w.welder_id IS NULL        AND ISNULL(w.welder, '')    <> '')
       OR (w.inspector_id IS NULL     AND ISNULL(w.inspector, '') <> ''));


-- ============================================================================================
-- G. DATE strings that none of the known formats can parse (blocks the move to DATE columns)
-- ============================================================================================
SELECT 'cert.valid_until' AS col, valid_until AS val, COUNT(*) AS n FROM weldoc_weldercertificate
WHERE ISNULL(valid_until, '') <> ''
  AND COALESCE(TRY_CONVERT(date, valid_until, 23), TRY_CONVERT(date, valid_until, 104), TRY_CONVERT(date, valid_until, 103),
               TRY_CONVERT(date, valid_until, 105), TRY_CONVERT(date, valid_until, 111), TRY_CONVERT(date, valid_until, 102)) IS NULL
GROUP BY valid_until
UNION ALL
SELECT 'weld.date', date, COUNT(*) FROM weldoc_welds
WHERE ISNULL(date, '') <> ''
  AND COALESCE(TRY_CONVERT(date, LEFT(date, 10), 23), TRY_CONVERT(date, date, 104), TRY_CONVERT(date, date, 103),
               TRY_CONVERT(date, date, 105), TRY_CONVERT(date, date, 111), TRY_CONVERT(date, date, 102)) IS NULL
GROUP BY date;
