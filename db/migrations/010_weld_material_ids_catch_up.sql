-- 010_weld_material_ids_catch_up.sql
--
-- PHASE 2 of "welds point to materials by id" - run right after the phase 2 code is live.
--
-- WHAT IT DOES
--   Welds created after 009 by the code that did not know the ids yet have empty
--   material_a_id / material_b_id. This fills them in with exactly the rule 009 used: an
--   ACTIVE weld whose two letters each match exactly one active material of its pipeline,
--   and the two differ. Everything else is left as it is (archived welds, welds that cannot
--   be matched - those show as "needs checking" in the weld list).
--   The phase 2 code also does this by itself whenever it works on a pipeline; this file just
--   completes all pipelines at once.
--
-- DATA
--   Only material_a_id / material_b_id of such welds are set. Nothing is deleted, no letter
--   or other value changes. Running it again changes nothing.

SET XACT_ABORT ON;
SET NOCOUNT ON;

CREATE TABLE #mat (id INT, pipeline_id INT, position NVARCHAR(10), same_letter INT);
INSERT #mat (id, pipeline_id, position, same_letter)
SELECT id, pipeline_id, position, COUNT(*) OVER (PARTITION BY pipeline_id, position)
FROM weldoc_pipeline_materials
WHERE archived = 0 AND position IS NOT NULL AND position <> '';

CREATE TABLE #res (weld_id INT, outcome VARCHAR(20), a_id INT, b_id INT);
INSERT #res (weld_id, outcome, a_id, b_id)
SELECT w.id,
       CASE
           WHEN ISNULL(w.between_a, '') = '' OR ISNULL(w.between_b, '') = '' THEN 'letters_empty'
           WHEN a.n IS NULL OR b.n IS NULL THEN 'letter_missing'
           WHEN a.n > 1 OR b.n > 1 THEN 'letter_duplicate'
           WHEN a.id = b.id THEN 'same_material'
           ELSE 'filled'
       END,
       a.id, b.id
FROM weldoc_welds w
OUTER APPLY (SELECT MIN(m.id) AS id, MAX(m.same_letter) AS n FROM #mat m WHERE m.pipeline_id = w.pipeline_id AND m.position = w.between_a) a
OUTER APPLY (SELECT MIN(m.id) AS id, MAX(m.same_letter) AS n FROM #mat m WHERE m.pipeline_id = w.pipeline_id AND m.position = w.between_b) b
WHERE w.archived = 0 AND (w.material_a_id IS NULL OR w.material_b_id IS NULL);

UPDATE w SET material_a_id = r.a_id, material_b_id = r.b_id
FROM weldoc_welds w JOIN #res r ON r.weld_id = w.id
WHERE r.outcome = 'filled';

-- Report
SELECT outcome, COUNT(*) AS active_welds_without_ids_before
FROM #res GROUP BY outcome ORDER BY outcome;

SELECT SUM(CASE WHEN archived = 0 AND material_a_id IS NOT NULL AND material_b_id IS NOT NULL THEN 1 ELSE 0 END) AS active_with_ids,
       SUM(CASE WHEN archived = 0 AND (material_a_id IS NULL OR material_b_id IS NULL) THEN 1 ELSE 0 END) AS active_needs_checking,
       SUM(CASE WHEN archived = 1 THEN 1 ELSE 0 END) AS archived
FROM weldoc_welds;

DROP TABLE #mat;
DROP TABLE #res;
