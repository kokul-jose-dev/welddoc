-- 011_archive_log_and_order.sql
--
-- "Archive after welding": once a welder or inspector is on a weld of a pipeline, archiving a
-- material no longer hides it and deletes its welds - both stay in the lists, struck through,
-- with who archived them, when and why. And the material list follows the pipe, so a
-- material added into the gap sits where the archived one was, with its own letter.
--
-- WHAT IT DOES
--   1. weldoc_pipeline_materials and weldoc_welds get:
--        archived_at      DATETIME2       when it was archived              (NULL = not logged)
--        archived_by      NVARCHAR(255)   who archived it (the signed-in user)
--        archive_reason   NVARCHAR(1000)  why - required for a struck-through row
--        struck           BIT, default 0  1 = archived after welding: shown struck through
--      weldoc_pipeline_materials also gets:
--        sort_order       INT             place in the material list (NULL = by letter)
--   2. Rules (checked by the database):
--        - a struck row is archived and has a reason
--   3. sort_order of the ACTIVE materials is filled in from their current letter order
--      (A = 1, B = 2, ... per pipeline), so the list looks exactly as before.
--
-- REQUIRES
--   Nothing. Run it BEFORE the app version that uses these columns is deployed: the current
--   app does not know them and keeps working (every new column is empty or has a default).
--
-- DATA
--   No row is deleted, no existing value is changed - only the new columns are filled.
--   Running it again changes nothing.
--
-- Only weldoc_pipeline_materials and weldoc_welds get columns and rules.

SET XACT_ABORT ON;
SET NOCOUNT ON;

-- 0. Baseline, before anything
SELECT 'before' AS [when],
       (SELECT COUNT(*) FROM weldoc_pipeline_materials) AS materials_total,
       (SELECT COUNT(*) FROM weldoc_pipeline_materials WHERE archived = 0) AS materials_active,
       (SELECT COUNT(*) FROM weldoc_welds) AS welds_total,
       (SELECT COUNT(*) FROM weldoc_welds WHERE archived = 0) AS welds_active
INTO #baseline;

-- 1. Columns
IF COL_LENGTH('weldoc_pipeline_materials', 'archived_at') IS NULL
    ALTER TABLE weldoc_pipeline_materials ADD archived_at DATETIME2 NULL;
IF COL_LENGTH('weldoc_pipeline_materials', 'archived_by') IS NULL
    ALTER TABLE weldoc_pipeline_materials ADD archived_by NVARCHAR(255) NULL;
IF COL_LENGTH('weldoc_pipeline_materials', 'archive_reason') IS NULL
    ALTER TABLE weldoc_pipeline_materials ADD archive_reason NVARCHAR(1000) NULL;
IF COL_LENGTH('weldoc_pipeline_materials', 'struck') IS NULL
    ALTER TABLE weldoc_pipeline_materials ADD struck BIT NOT NULL
        CONSTRAINT DF_weldoc_pipeline_materials_struck DEFAULT 0;
IF COL_LENGTH('weldoc_pipeline_materials', 'sort_order') IS NULL
    ALTER TABLE weldoc_pipeline_materials ADD sort_order INT NULL;

IF COL_LENGTH('weldoc_welds', 'archived_at') IS NULL
    ALTER TABLE weldoc_welds ADD archived_at DATETIME2 NULL;
IF COL_LENGTH('weldoc_welds', 'archived_by') IS NULL
    ALTER TABLE weldoc_welds ADD archived_by NVARCHAR(255) NULL;
IF COL_LENGTH('weldoc_welds', 'archive_reason') IS NULL
    ALTER TABLE weldoc_welds ADD archive_reason NVARCHAR(1000) NULL;
IF COL_LENGTH('weldoc_welds', 'struck') IS NULL
    ALTER TABLE weldoc_welds ADD struck BIT NOT NULL
        CONSTRAINT DF_weldoc_welds_struck DEFAULT 0;
GO

SET XACT_ABORT ON;
SET NOCOUNT ON;

-- 2. Rules
IF OBJECT_ID('CK_weldoc_pipeline_materials_struck', 'C') IS NULL
    ALTER TABLE weldoc_pipeline_materials WITH CHECK ADD CONSTRAINT CK_weldoc_pipeline_materials_struck
        CHECK (struck = 0 OR (archived = 1 AND archive_reason IS NOT NULL AND LEN(archive_reason) > 0));
IF OBJECT_ID('CK_weldoc_welds_struck', 'C') IS NULL
    ALTER TABLE weldoc_welds WITH CHECK ADD CONSTRAINT CK_weldoc_welds_struck
        CHECK (struck = 0 OR (archived = 1 AND archive_reason IS NOT NULL AND LEN(archive_reason) > 0));

-- 3. sort_order of the active materials = their current letter order (only where still empty)
;WITH ranked AS (
    SELECT id, sort_order,
           ROW_NUMBER() OVER (PARTITION BY pipeline_id ORDER BY LEN(position), position, id) AS rn
    FROM weldoc_pipeline_materials
    WHERE archived = 0
)
UPDATE ranked SET sort_order = rn WHERE sort_order IS NULL;

-- 4. Report
-- 4a. Baseline: must be identical before and after
SELECT * FROM #baseline
UNION ALL
SELECT 'after',
       (SELECT COUNT(*) FROM weldoc_pipeline_materials),
       (SELECT COUNT(*) FROM weldoc_pipeline_materials WHERE archived = 0),
       (SELECT COUNT(*) FROM weldoc_welds),
       (SELECT COUNT(*) FROM weldoc_welds WHERE archived = 0);

-- 4b. sort_order: every active material has one, and it follows the letters
SELECT SUM(CASE WHEN archived = 0 AND sort_order IS NOT NULL THEN 1 ELSE 0 END) AS active_with_sort_order,
       SUM(CASE WHEN archived = 0 AND sort_order IS NULL THEN 1 ELSE 0 END) AS active_without_sort_order,
       SUM(CASE WHEN struck = 1 THEN 1 ELSE 0 END) AS struck_materials
FROM weldoc_pipeline_materials;

SELECT SUM(CASE WHEN struck = 1 THEN 1 ELSE 0 END) AS struck_welds FROM weldoc_welds;

DROP TABLE #baseline;
