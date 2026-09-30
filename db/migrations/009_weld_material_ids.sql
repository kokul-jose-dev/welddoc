-- 009_weld_material_ids.sql
--
-- PHASE 1 of "welds point to materials by id" (expand - nothing is removed).
--
-- WHAT IT DOES
--   1. Adds two columns to weldoc_welds, next to the letters between_a / between_b:
--        material_a_id, material_b_id  ->  weldoc_pipeline_materials.id
--   2. Rules on them (checked by the database):
--        - each points to a pipeline material of THE SAME PIPELINE as the weld
--          (composite foreign key on pipeline_id + material id)
--        - a weld cannot join a material to itself
--        - empty (NULL) is allowed: a weld not matched yet
--   3. Fills them in for ACTIVE welds by looking up their current letters: a letter must match
--      exactly one active material of the weld's pipeline, and the two must differ.
--      - Archived welds are NOT filled in: their letters are history, and those letters may
--        belong to other materials by now. They keep their letters.
--      - Active welds whose letters cannot be matched keep everything they have; their ids
--        stay empty and they are listed in the report (to be assigned by hand later).
--      - Welds that already have ids are left as they are (running this again changes nothing).
--
-- DATA
--   No row is deleted, no letter or other value is changed. The app keeps working as before;
--   it does not read or write the new columns until phase 2.
--
-- Only weldoc_welds gets columns and rules; weldoc_pipeline_materials gets one UNIQUE key on
-- (pipeline_id, id), which is always true because id alone is already unique - the composite
-- foreign key needs it.

SET XACT_ABORT ON;
SET NOCOUNT ON;

-- 0. Baseline, before anything
SELECT 'before' AS [when],
       COUNT(*) AS welds_total,
       SUM(CASE WHEN archived = 0 THEN 1 ELSE 0 END) AS welds_active,
       SUM(CASE WHEN welder_id IS NOT NULL THEN 1 ELSE 0 END) AS with_welder,
       SUM(CASE WHEN inspector_id IS NOT NULL THEN 1 ELSE 0 END) AS with_inspector
INTO #baseline
FROM weldoc_welds;

-- 1. Columns
IF COL_LENGTH('weldoc_welds', 'material_a_id') IS NULL
    ALTER TABLE weldoc_welds ADD material_a_id INT NULL;
IF COL_LENGTH('weldoc_welds', 'material_b_id') IS NULL
    ALTER TABLE weldoc_welds ADD material_b_id INT NULL;
GO

SET XACT_ABORT ON;
SET NOCOUNT ON;

-- 2. Rules
IF NOT EXISTS (SELECT 1 FROM sys.key_constraints WHERE name = 'UQ_weldoc_pipeline_materials_pipeline_id')
    ALTER TABLE weldoc_pipeline_materials
        ADD CONSTRAINT UQ_weldoc_pipeline_materials_pipeline_id UNIQUE (pipeline_id, id);

IF OBJECT_ID('FK_weldoc_welds_material_a', 'F') IS NULL
    ALTER TABLE weldoc_welds WITH CHECK ADD CONSTRAINT FK_weldoc_welds_material_a
        FOREIGN KEY (pipeline_id, material_a_id) REFERENCES weldoc_pipeline_materials (pipeline_id, id);
IF OBJECT_ID('FK_weldoc_welds_material_b', 'F') IS NULL
    ALTER TABLE weldoc_welds WITH CHECK ADD CONSTRAINT FK_weldoc_welds_material_b
        FOREIGN KEY (pipeline_id, material_b_id) REFERENCES weldoc_pipeline_materials (pipeline_id, id);

IF OBJECT_ID('CK_weldoc_welds_two_materials', 'C') IS NULL
    ALTER TABLE weldoc_welds WITH CHECK ADD CONSTRAINT CK_weldoc_welds_two_materials
        CHECK (material_a_id IS NULL OR material_b_id IS NULL OR material_a_id <> material_b_id);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID('weldoc_welds') AND name = 'IX_weldoc_welds_material_a')
    CREATE NONCLUSTERED INDEX IX_weldoc_welds_material_a ON weldoc_welds (material_a_id);
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID('weldoc_welds') AND name = 'IX_weldoc_welds_material_b')
    CREATE NONCLUSTERED INDEX IX_weldoc_welds_material_b ON weldoc_welds (material_b_id);

-- 3. Fill in: active welds whose two letters each match exactly one active material
CREATE TABLE #mat (id INT, pipeline_id INT, position NVARCHAR(10), same_letter INT);
INSERT #mat (id, pipeline_id, position, same_letter)
SELECT id, pipeline_id, position, COUNT(*) OVER (PARTITION BY pipeline_id, position)
FROM weldoc_pipeline_materials
WHERE archived = 0 AND position IS NOT NULL AND position <> '';

CREATE TABLE #res (weld_id INT, outcome VARCHAR(20), a_id INT, b_id INT);
INSERT #res (weld_id, outcome, a_id, b_id)
SELECT w.id,
       CASE
           WHEN w.material_a_id IS NOT NULL AND w.material_b_id IS NOT NULL THEN 'already_set'
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
WHERE w.archived = 0;

UPDATE w SET material_a_id = r.a_id, material_b_id = r.b_id
FROM weldoc_welds w JOIN #res r ON r.weld_id = w.id
WHERE r.outcome = 'filled';

-- 4. Report
-- 4a. Baseline: must be identical before and after
SELECT * FROM #baseline
UNION ALL
SELECT 'after', COUNT(*), SUM(CASE WHEN archived = 0 THEN 1 ELSE 0 END),
       SUM(CASE WHEN welder_id IS NOT NULL THEN 1 ELSE 0 END), SUM(CASE WHEN inspector_id IS NOT NULL THEN 1 ELSE 0 END)
FROM weldoc_welds;

-- 4b. What happened to the active welds
SELECT outcome, COUNT(*) AS active_welds,
       CASE outcome WHEN 'filled' THEN 'material ids filled in'
                    WHEN 'already_set' THEN 'had ids already - unchanged'
                    ELSE 'ids left empty - to assign by hand (all other data kept)' END AS what_happened
FROM #res GROUP BY outcome
ORDER BY CASE outcome WHEN 'filled' THEN 1 WHEN 'already_set' THEN 2 ELSE 3 END, outcome;

-- 4c. The active welds left for a hand check
SELECT pl.no AS pipeline_no, w.weld_no, w.id AS weld_id, w.between_a, w.between_b, r.outcome,
       w.welder_id, w.inspector_id, w.date
FROM #res r
JOIN weldoc_welds w ON w.id = r.weld_id
JOIN weldoc_pipelines pl ON pl.id = w.pipeline_id
WHERE r.outcome NOT IN ('filled', 'already_set')
ORDER BY pl.no, w.weld_no;

-- 4d. Check: every filled weld's ids match its letters right now
SELECT COUNT(*) AS filled_welds_whose_letters_do_not_match_their_materials
FROM weldoc_welds w
JOIN weldoc_pipeline_materials a ON a.id = w.material_a_id
JOIN weldoc_pipeline_materials b ON b.id = w.material_b_id
WHERE w.archived = 0 AND (ISNULL(a.position, '') <> ISNULL(w.between_a, '') OR ISNULL(b.position, '') <> ISNULL(w.between_b, ''));

DROP TABLE #baseline;
DROP TABLE #mat;
DROP TABLE #res;
