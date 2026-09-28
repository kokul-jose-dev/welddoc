-- 03_weld_material_mapping.sql  (READ-ONLY)
--
-- Phase 0 of "welds point to materials by id": for every weld, can its two position letters
-- (between_a / between_b) be turned into the ids of exactly one material each?
-- This is the same lookup migration 008 will do, so the result says in advance which welds
-- get their ids automatically and which have to be checked by hand. Nothing is changed.
--
--   weldoc\venv\Scripts\python db\run_check.py db\checks\03_weld_material_mapping.sql
--   weldoc\venv\Scripts\python db\run_check.py db\checks\03_weld_material_mapping.sql --env .env.prod
--
-- Outcomes per weld:
--   ok                 both letters match exactly one active material of the weld's pipeline
--   ok_not_connected   matches, but the two materials are not connected (the weld still keeps
--                      its materials; the missing connection is shown for information)
--   letter_missing     a letter matches no active material (e.g. its material was archived)
--   letter_duplicate   a letter matches two or more active materials (e.g. two materials "C")
--   same_material      both letters point to the same material
--   letters_empty      between_a or between_b is empty
--   archived_weld      the weld itself is archived - history, looked at separately

SET NOCOUNT ON;

-- Active materials per pipeline, with how many share each letter
IF OBJECT_ID('tempdb..#mat') IS NOT NULL DROP TABLE #mat;
SELECT pm.id, pm.pipeline_id, pm.position,
       COUNT(*) OVER (PARTITION BY pm.pipeline_id, pm.position) AS same_letter
INTO #mat
FROM weldoc_pipeline_materials pm
WHERE pm.archived = 0 AND pm.position IS NOT NULL AND pm.position <> '';

-- Connected pairs (either direction), lo < hi
IF OBJECT_ID('tempdb..#pairs') IS NOT NULL DROP TABLE #pairs;
SELECT DISTINCT CASE WHEN c.pipeline_material_id < c.connected_id THEN c.pipeline_material_id ELSE c.connected_id END AS lo,
                CASE WHEN c.pipeline_material_id < c.connected_id THEN c.connected_id ELSE c.pipeline_material_id END AS hi
INTO #pairs
FROM weldoc_pipeline_material_connections c;

-- Every weld with its lookup result
IF OBJECT_ID('tempdb..#w') IS NOT NULL DROP TABLE #w;
SELECT w.id AS weld_id, w.pipeline_id, pl.no AS pipeline_no, w.weld_no, w.between_a, w.between_b, w.archived,
       w.welder_id, w.inspector_id, w.date, w.visual, w.endoscopy,
       -- an empty date counts as no date (before 007 the column is text and may hold '')
       CASE WHEN w.welder_id IS NOT NULL OR w.inspector_id IS NOT NULL
                 OR NULLIF(LTRIM(RTRIM(CAST(w.date AS NVARCHAR(20)))), '') IS NOT NULL
                 OR ISNULL(w.visual, '') NOT IN ('', 'n/a') OR ISNULL(w.endoscopy, '') NOT IN ('', 'n/a')
                 OR ISNULL(CAST(w.remarks AS NVARCHAR(4000)), '') <> ''
                 OR ISNULL(w.endoscopy_image_url, '') <> '' OR ISNULL(w.endoscopy_video_url, '') <> ''
            THEN 1 ELSE 0 END AS has_work,
       (SELECT COUNT(*) FROM #mat m WHERE m.pipeline_id = w.pipeline_id AND m.position = w.between_a) AS a_matches,
       (SELECT COUNT(*) FROM #mat m WHERE m.pipeline_id = w.pipeline_id AND m.position = w.between_b) AS b_matches,
       (SELECT MIN(m.id) FROM #mat m WHERE m.pipeline_id = w.pipeline_id AND m.position = w.between_a) AS material_a_id,
       (SELECT MIN(m.id) FROM #mat m WHERE m.pipeline_id = w.pipeline_id AND m.position = w.between_b) AS material_b_id
INTO #w
FROM weldoc_welds w
LEFT JOIN weldoc_pipelines pl ON pl.id = w.pipeline_id;

ALTER TABLE #w ADD outcome VARCHAR(20);
UPDATE #w SET outcome = CASE
    WHEN archived = 1 THEN 'archived_weld'
    WHEN ISNULL(between_a, '') = '' OR ISNULL(between_b, '') = '' THEN 'letters_empty'
    WHEN a_matches = 0 OR b_matches = 0 THEN 'letter_missing'
    WHEN a_matches > 1 OR b_matches > 1 THEN 'letter_duplicate'
    WHEN material_a_id = material_b_id THEN 'same_material'
    WHEN NOT EXISTS (SELECT 1 FROM #pairs p
                     WHERE p.lo = CASE WHEN material_a_id < material_b_id THEN material_a_id ELSE material_b_id END
                       AND p.hi = CASE WHEN material_a_id < material_b_id THEN material_b_id ELSE material_a_id END)
         THEN 'ok_not_connected'
    ELSE 'ok' END;


-- 1. BASELINE - write these numbers down; they must be identical after every later step
SELECT COUNT(*)                                           AS welds_total,
       SUM(CASE WHEN archived = 0 THEN 1 ELSE 0 END)       AS welds_active,
       SUM(CASE WHEN archived = 1 THEN 1 ELSE 0 END)       AS welds_archived,
       SUM(has_work)                                       AS welds_with_recorded_work,
       SUM(CASE WHEN welder_id IS NOT NULL THEN 1 ELSE 0 END)    AS with_welder,
       SUM(CASE WHEN inspector_id IS NOT NULL THEN 1 ELSE 0 END) AS with_inspector
FROM #w;

-- 2. OUTCOME - how many welds get their material ids automatically
SELECT outcome,
       COUNT(*) AS welds,
       SUM(has_work) AS of_which_with_recorded_work,
       CASE outcome
           WHEN 'ok'               THEN 'ids filled in automatically'
           WHEN 'ok_not_connected' THEN 'ids filled in automatically; the connection is missing (info)'
           WHEN 'archived_weld'    THEN 'history - ids only if its letters still match'
           ELSE 'kept as it is, marked "needs checking", fixed by hand'
       END AS what_happens
FROM #w
GROUP BY outcome
ORDER BY CASE outcome WHEN 'ok' THEN 1 WHEN 'ok_not_connected' THEN 2 WHEN 'archived_weld' THEN 9 ELSE 5 END, outcome;

-- 3. PER PIPELINE - active welds only
SELECT pipeline_id, pipeline_no,
       COUNT(*) AS active_welds,
       SUM(CASE WHEN outcome IN ('ok', 'ok_not_connected') THEN 1 ELSE 0 END) AS automatic,
       SUM(CASE WHEN outcome NOT IN ('ok', 'ok_not_connected') THEN 1 ELSE 0 END) AS needs_checking,
       SUM(CASE WHEN outcome NOT IN ('ok', 'ok_not_connected') AND has_work = 1 THEN 1 ELSE 0 END) AS needs_checking_with_work
FROM #w
WHERE archived = 0
GROUP BY pipeline_id, pipeline_no
HAVING SUM(CASE WHEN outcome NOT IN ('ok', 'ok_not_connected') THEN 1 ELSE 0 END) > 0
ORDER BY needs_checking_with_work DESC, needs_checking DESC, pipeline_id;

-- 4. THE HAND-CHECK LIST - active welds that cannot be matched automatically
SELECT w.pipeline_no, w.weld_no, w.weld_id, w.between_a, w.between_b, w.outcome,
       w.has_work, w.welder_id, w.inspector_id, w.date,
       -- which materials currently carry these letters (helps choosing the right one)
       STUFF((SELECT N', ' + CAST(m.id AS NVARCHAR(10)) FROM #mat m
              WHERE m.pipeline_id = w.pipeline_id AND m.position = w.between_a
              FOR XML PATH(''), TYPE).value('.', 'NVARCHAR(MAX)'), 1, 2, N'') AS materials_with_letter_a,
       STUFF((SELECT N', ' + CAST(m.id AS NVARCHAR(10)) FROM #mat m
              WHERE m.pipeline_id = w.pipeline_id AND m.position = w.between_b
              FOR XML PATH(''), TYPE).value('.', 'NVARCHAR(MAX)'), 1, 2, N'') AS materials_with_letter_b
FROM #w w
WHERE w.archived = 0 AND w.outcome NOT IN ('ok', 'ok_not_connected')
ORDER BY w.has_work DESC, w.pipeline_no, w.weld_no;

-- 5. MATCHED BUT NOT CONNECTED - active welds whose two materials have no connection
SELECT pipeline_no, weld_no, weld_id, between_a, between_b, material_a_id, material_b_id, has_work
FROM #w
WHERE outcome = 'ok_not_connected'
ORDER BY pipeline_no, weld_no;

-- 6. DUPLICATE LETTERS - the cause of 'letter_duplicate'; fix these before renumbering
SELECT m.pipeline_id, pl.no AS pipeline_no, m.position AS letter, COUNT(*) AS materials,
       STUFF((SELECT N', ' + CAST(m2.id AS NVARCHAR(10)) FROM #mat m2
              WHERE m2.pipeline_id = m.pipeline_id AND m2.position = m.position
              FOR XML PATH(''), TYPE).value('.', 'NVARCHAR(MAX)'), 1, 2, N'') AS material_ids
FROM #mat m
JOIN weldoc_pipelines pl ON pl.id = m.pipeline_id
WHERE m.same_letter > 1
GROUP BY m.pipeline_id, pl.no, m.position
ORDER BY m.pipeline_id, m.position;
