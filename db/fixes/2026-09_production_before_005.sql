-- 2026-09_production_before_005.sql      ONE-OFF DATA CORRECTION FOR PRODUCTION
--
-- Not a migration: it corrects a few production rows that migrations 005 and 006 cannot
-- convert on their own (found by their dry run on production, 2026-09-28). Run it once on
-- production, after the new code is deployed and before 005 / 006. Local does not need it.
--
-- WHAT IT CHANGES
--   1. Catalogue entries (reducers, tees) with both wall thicknesses in one field, e.g.
--      thickness = "2.0/1.6", are split the way the current form stores them:
--          thickness = "2.0", thickness2 = "1.6"
--      Only when thickness2 is empty or holds the same combined text (entry #279).
--      If thickness2 holds something else, the script STOPS and changes nothing.
--   2. Project #3 is test data (client "test", title "sdf"): its IST project number "sdfsd"
--      becomes 9999999, clearly a test number.
--
-- WHAT IT DOES NOT CHANGE
--   No row is deleted. No connection is touched. Project #1 (empty IST number) is left
--   empty - see the note in the handover; migration 006 decides how empty is stored.
--
-- Dry run (always rolled back):
--   weldoc\venv\Scripts\python db\run_check.py db\fixes\2026-09_production_before_005.sql --env .env.prod

SET XACT_ABORT ON;
SET NOCOUNT ON;

DECLARE @msg NVARCHAR(2048), @bad NVARCHAR(MAX);

-- 0. Before: what will be split
SELECT id, category, item_description, dn1, dn2, diameter, diameter2,
       thickness AS thickness_before, thickness2 AS thickness2_before
INTO #split
FROM weldoc_global_materials
WHERE thickness LIKE '%/%' OR thickness2 LIKE '%/%';

-- Stop if a value has more than one "/", or thickness2 holds a different value already
SELECT @bad = STUFF((
    SELECT N'; id ' + CAST(id AS NVARCHAR(10)) + N' thickness="' + ISNULL(thickness_before, N'') + N'" thickness2="' + ISNULL(thickness2_before, N'') + N'"'
    FROM #split
    WHERE ISNULL(thickness_before, N'') NOT LIKE N'%/%'
       OR LEN(thickness_before) - LEN(REPLACE(thickness_before, N'/', N'')) <> 1
       OR NOT (ISNULL(LTRIM(RTRIM(thickness2_before)), N'') = N''
               OR LTRIM(RTRIM(thickness2_before)) = LTRIM(RTRIM(thickness_before)))
    FOR XML PATH(''), TYPE).value('.', 'NVARCHAR(MAX)'), 1, 2, N'');
IF @bad IS NOT NULL
BEGIN
    SET @msg = LEFT(N'Fix stopped, nothing changed. These entries do not fit the "a/b, second field empty" pattern: ' + @bad, 2048);
    THROW 50001, @msg, 1;
END

-- 1. Split
UPDATE g SET
    thickness  = LTRIM(RTRIM(LEFT(s.thickness_before, CHARINDEX(N'/', s.thickness_before) - 1))),
    thickness2 = LTRIM(RTRIM(SUBSTRING(s.thickness_before, CHARINDEX(N'/', s.thickness_before) + 1, 50)))
FROM weldoc_global_materials g
JOIN #split s ON s.id = g.id;

-- 2. Test project #3 - only if it is still exactly the test row seen on 2026-09-28
UPDATE weldoc_projects SET ist_project_no = N'9999999'
WHERE id = 3 AND ist_project_no = N'sdfsd' AND title = N'sdf';
IF @@ROWCOUNT <> 1
    THROW 50002, N'Fix stopped, nothing changed: project #3 is no longer the expected test row (IST "sdfsd", title "sdf").', 1;

-- Report: before -> after
SELECT s.id, s.category, s.dn1, s.dn2, s.diameter,
       s.thickness_before, s.thickness2_before,
       g.thickness AS thickness_after, g.thickness2 AS thickness2_after
FROM #split s JOIN weldoc_global_materials g ON g.id = s.id
ORDER BY s.id;

SELECT id, ist_project_no, title FROM weldoc_projects WHERE id IN (1, 3) ORDER BY id;

DROP TABLE #split;
