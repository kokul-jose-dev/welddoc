-- 003_allowed_values.sql
--
-- WHAT IT DOES
--   Adds allowed-value rules (CHECK constraints), so these columns can only hold values the
--   app and the exported documents understand:
--     weldoc_welds.visual      ok | not ok | n/a  (also na, n.a.)  or empty
--     weldoc_welds.endoscopy   same
--     weldoc_welds.type        O-V | O-M | H-V | H-M, the older H | O | V | M, or empty
--     weldoc_pipelines.status  0 to 5 (the six workflow steps), or empty
--   Upper / lower case and surrounding spaces do not matter - the app stores "OK", "Not OK".
--
-- WHY
--   These values are printed on the signed weld inspection list. A typo, a bug or a stale
--   browser tab must never be able to put an invented result or step there.
--
-- DATA
--   Nothing is changed or deleted. First every existing row is checked: if any value is not
--   on the lists above, the script STOPS, changes nothing and names the values - so the
--   list can be extended on purpose rather than an old row later refusing to be edited.
--   (A CHECK rule re-checks a row whenever it is edited, even for an unrelated field.)
--   The older weld types H / O / V / M are on the list for exactly that reason.
--
-- Only weldoc_welds and weldoc_pipelines get constraints.

SET XACT_ABORT ON;
SET NOCOUNT ON;

DECLARE @bad NVARCHAR(MAX), @msg NVARCHAR(2048);

-- 1. Existing values that the rules would refuse.
SELECT @bad = STUFF((
    SELECT N'; ' + v.col + N' = ' + ISNULL(N'"' + v.val + N'"', N'NULL') + N' (' + CAST(v.n AS NVARCHAR(10)) + N'x)'
    FROM (
        SELECT 'welds.visual' AS col, visual AS val, COUNT(*) AS n FROM weldoc_welds
        WHERE visual IS NOT NULL AND LOWER(LTRIM(RTRIM(visual))) NOT IN ('', 'ok', 'not ok', 'n/a', 'na', 'n.a.')
        GROUP BY visual
        UNION ALL
        SELECT 'welds.endoscopy', endoscopy, COUNT(*) FROM weldoc_welds
        WHERE endoscopy IS NOT NULL AND LOWER(LTRIM(RTRIM(endoscopy))) NOT IN ('', 'ok', 'not ok', 'n/a', 'na', 'n.a.')
        GROUP BY endoscopy
        UNION ALL
        SELECT 'welds.type', [type], COUNT(*) FROM weldoc_welds
        WHERE [type] IS NOT NULL AND UPPER(LTRIM(RTRIM([type]))) NOT IN ('', 'O-V', 'O-M', 'H-V', 'H-M', 'H', 'O', 'V', 'M')
        GROUP BY [type]
        UNION ALL
        SELECT 'pipelines.status', CAST(status AS NVARCHAR(20)), COUNT(*) FROM weldoc_pipelines
        WHERE status IS NOT NULL AND status NOT BETWEEN 0 AND 5
        GROUP BY status
    ) v
    FOR XML PATH(''), TYPE).value('.', 'NVARCHAR(MAX)'), 1, 2, N'');

IF @bad IS NOT NULL
BEGIN
    SET @msg = LEFT(N'003 stopped, nothing changed. Values not on the allowed lists: ' + @bad
                  + N'. Decide whether to add them to the list in this file (it has not been applied yet) and run again.', 2048);
    THROW 50001, @msg, 1;
END

-- 2. Add the rules. Every existing row has just passed, so they are added WITH CHECK
--    (trusted: they hold for all rows, old and new). Skipped if already there.
IF OBJECT_ID('CK_weldoc_welds_visual', 'C') IS NULL
    ALTER TABLE weldoc_welds WITH CHECK ADD CONSTRAINT CK_weldoc_welds_visual
        CHECK (visual IS NULL OR LOWER(LTRIM(RTRIM(visual))) IN ('', 'ok', 'not ok', 'n/a', 'na', 'n.a.'));

IF OBJECT_ID('CK_weldoc_welds_endoscopy', 'C') IS NULL
    ALTER TABLE weldoc_welds WITH CHECK ADD CONSTRAINT CK_weldoc_welds_endoscopy
        CHECK (endoscopy IS NULL OR LOWER(LTRIM(RTRIM(endoscopy))) IN ('', 'ok', 'not ok', 'n/a', 'na', 'n.a.'));

IF OBJECT_ID('CK_weldoc_welds_type', 'C') IS NULL
    ALTER TABLE weldoc_welds WITH CHECK ADD CONSTRAINT CK_weldoc_welds_type
        CHECK ([type] IS NULL OR UPPER(LTRIM(RTRIM([type]))) IN ('', 'O-V', 'O-M', 'H-V', 'H-M', 'H', 'O', 'V', 'M'));

IF OBJECT_ID('CK_weldoc_pipelines_status', 'C') IS NULL
    ALTER TABLE weldoc_pipelines WITH CHECK ADD CONSTRAINT CK_weldoc_pipelines_status
        CHECK (status IS NULL OR status BETWEEN 0 AND 5);

-- 3. Report.
SELECT OBJECT_NAME(cc.parent_object_id) AS [table], cc.name AS [rule],
       CASE WHEN cc.is_not_trusted = 1 THEN 'new/edited rows only' ELSE 'all rows' END AS checks,
       cc.definition
FROM sys.check_constraints cc
WHERE cc.name IN ('CK_weldoc_welds_visual', 'CK_weldoc_welds_endoscopy', 'CK_weldoc_welds_type', 'CK_weldoc_pipelines_status')
ORDER BY [table], [rule];
