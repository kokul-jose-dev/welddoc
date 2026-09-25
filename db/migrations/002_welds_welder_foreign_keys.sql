-- 002_welds_welder_foreign_keys.sql
--
-- WHAT IT DOES
--   Adds two foreign keys on weldoc_welds:
--     welder_id    -> weldoc_welders.id
--     inspector_id -> weldoc_welders.id
--   From now on the database refuses to save a weld whose welder or inspector does not
--   exist. Empty (NULL) stays allowed - a weld with nobody assigned yet is normal.
--   Archived welders still exist (archived = 1, the row is kept), so welds keep them.
--   A welder who has welds can no longer be deleted outright - only archived.
--
-- WHY
--   The Python model already declares these keys, but the columns were added later with a
--   plain ALTER TABLE, so the database never got them and accepts any number.
--
-- DATA
--   Nothing is deleted or changed. The keys are added WITH NOCHECK: existing welds are not
--   checked, the rule applies to every weld inserted or edited from now on. The report at
--   the end counts existing welds pointing at a missing welder, for information only.
--
-- Only weldoc_welds gets a constraint; weldoc_welders is only referenced.

SET XACT_ABORT ON;
SET NOCOUNT ON;

DECLARE @msg NVARCHAR(2048);

-- 1. The columns must be what this file expects, otherwise stop.
IF COL_LENGTH('weldoc_welds', 'welder_id') IS NULL OR COL_LENGTH('weldoc_welds', 'inspector_id') IS NULL
    THROW 50001, N'002 stopped, nothing changed: weldoc_welds.welder_id / inspector_id not found.', 1;
IF NOT EXISTS (
    SELECT 1 FROM sys.indexes i
    JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
    JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
    WHERE i.object_id = OBJECT_ID('weldoc_welders') AND i.is_primary_key = 1 AND c.name = 'id')
    THROW 50002, N'002 stopped, nothing changed: weldoc_welders.id is not the primary key.', 1;

-- 2. Add each key unless that column already has a foreign key to weldoc_welders
--    (under any name) - running on an already fixed database does nothing.
IF NOT EXISTS (
    SELECT 1 FROM sys.foreign_key_columns fkc
    JOIN sys.columns c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id
    WHERE fkc.parent_object_id = OBJECT_ID('weldoc_welds') AND c.name = 'welder_id'
      AND fkc.referenced_object_id = OBJECT_ID('weldoc_welders'))
    ALTER TABLE weldoc_welds WITH NOCHECK
        ADD CONSTRAINT FK_weldoc_welds_welder FOREIGN KEY (welder_id) REFERENCES weldoc_welders (id);

IF NOT EXISTS (
    SELECT 1 FROM sys.foreign_key_columns fkc
    JOIN sys.columns c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id
    WHERE fkc.parent_object_id = OBJECT_ID('weldoc_welds') AND c.name = 'inspector_id'
      AND fkc.referenced_object_id = OBJECT_ID('weldoc_welders'))
    ALTER TABLE weldoc_welds WITH NOCHECK
        ADD CONSTRAINT FK_weldoc_welds_inspector FOREIGN KEY (inspector_id) REFERENCES weldoc_welders (id);

-- 3. Report.
SELECT fk.name AS foreign_key, c.name AS [column], OBJECT_NAME(fk.referenced_object_id) AS points_to,
       CASE WHEN fk.is_not_trusted = 1 THEN 'new/edited rows only (WITH NOCHECK)' ELSE 'all rows' END AS checks
FROM sys.foreign_keys fk
JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
JOIN sys.columns c ON c.object_id = fkc.parent_object_id AND c.column_id = fkc.parent_column_id
WHERE fk.parent_object_id = OBJECT_ID('weldoc_welds') AND c.name IN ('welder_id', 'inspector_id');

SELECT
    (SELECT COUNT(*) FROM weldoc_welds w WHERE w.welder_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM weldoc_welders x WHERE x.id = w.welder_id))    AS old_welds_missing_welder,
    (SELECT COUNT(*) FROM weldoc_welds w WHERE w.inspector_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM weldoc_welders x WHERE x.id = w.inspector_id)) AS old_welds_missing_inspector;
