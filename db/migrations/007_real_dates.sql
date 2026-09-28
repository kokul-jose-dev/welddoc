-- 007_real_dates.sql
--
-- WHAT IT DOES
--   These columns hold a real date from now on instead of text:
--     weldoc_welds.date                       text -> DATE
--     weldoc_pipelines.welding_start          text -> DATE
--     weldoc_pipelines.welding_end            text -> DATE
--     weldoc_weldercertificate.valid_until    text -> DATE
--     weldoc_weldercertificate.renewal_due    text -> DATE
--   The app shows them exactly as before (26.09.2026). Only valid dates can be saved, and
--   date questions become possible (e.g. "certificates expiring in the next 30 days").
--
-- REQUIRES
--   The app version with DateColumn in app/spec_values.py must be running first. It reads
--   both the old text and the new dates, so it works before and after this file.
--
-- DATA
--   Each value is read in the formats the app has used: 2026-07-10 (also with a time after
--   it), 10.07.2026, 10/07/2026, 10-07-2026, 2026/07/10, 2026.07.10. Empty stays empty.
--   Nothing is deleted. If ANY value is not a valid date in one of these formats (e.g.
--   "31.02.2026" or "next week") the script STOPS, changes nothing and lists those values.
--
-- Only these five columns are changed.

SET XACT_ABORT ON;
SET NOCOUNT ON;

DECLARE @cols TABLE (tbl SYSNAME, col SYSNAME, PRIMARY KEY (tbl, col));
INSERT @cols (tbl, col) VALUES
    ('weldoc_welds',             'date'),
    ('weldoc_pipelines',         'welding_start'),
    ('weldoc_pipelines',         'welding_end'),
    ('weldoc_weldercertificate', 'valid_until'),
    ('weldoc_weldercertificate', 'renewal_due');

DECLARE @sql NVARCHAR(MAX), @msg NVARCHAR(2048), @tbl SYSNAME, @col SYSNAME, @bad NVARCHAR(MAX);

-- 1. Every column must exist; columns that are already dates are skipped.
SELECT @msg = STUFF((SELECT N', ' + x.tbl + N'.' + x.col FROM @cols x
                     WHERE COL_LENGTH(x.tbl, x.col) IS NULL
                     FOR XML PATH(''), TYPE).value('.', 'NVARCHAR(MAX)'), 1, 2, N'');
IF @msg IS NOT NULL
BEGIN
    SET @msg = N'007 stopped, nothing changed: column(s) not found: ' + @msg;
    THROW 50001, @msg, 1;
END

DELETE x FROM @cols x
JOIN sys.columns c ON c.object_id = OBJECT_ID(x.tbl) AND c.name = x.col
JOIN sys.types ty ON ty.user_type_id = c.user_type_id
WHERE ty.name NOT IN ('varchar', 'nvarchar', 'char', 'nchar');

IF EXISTS (SELECT 1 FROM @cols x JOIN sys.columns c ON c.object_id = OBJECT_ID(x.tbl) AND c.name = x.col
           JOIN sys.index_columns ic ON ic.object_id = c.object_id AND ic.column_id = c.column_id)
OR EXISTS (SELECT 1 FROM @cols x JOIN sys.columns c ON c.object_id = OBJECT_ID(x.tbl) AND c.name = x.col
           JOIN sys.default_constraints dc ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id)
OR EXISTS (SELECT 1 FROM @cols x JOIN sys.columns c ON c.object_id = OBJECT_ID(x.tbl) AND c.name = x.col
           JOIN sys.check_constraints cc ON cc.parent_object_id = c.object_id AND cc.parent_column_id = c.column_id)
    THROW 50002, N'007 stopped, nothing changed: an index or constraint uses one of these columns.', 1;

-- 2. Read every value and try the known formats, most common first.
CREATE TABLE #conv (tbl SYSNAME, col SYSNAME, id INT, raw NVARCHAR(200), d DATE);

DECLARE c_read CURSOR LOCAL FAST_FORWARD FOR SELECT tbl, col FROM @cols;
OPEN c_read;
FETCH NEXT FROM c_read INTO @tbl, @col;
WHILE @@FETCH_STATUS = 0
BEGIN
    SET @sql = N'
        INSERT #conv (tbl, col, id, raw, d)
        SELECT @tbl, @col, id, v,
               CASE
                   WHEN v LIKE N''[0-9][0-9][0-9][0-9]-[0-9]%'' THEN TRY_CONVERT(DATE, LEFT(v, 10), 23)   -- 2026-07-10[T...]
                   WHEN v LIKE N''[0-9]%.[0-9]%.[0-9][0-9][0-9][0-9]'' THEN TRY_CONVERT(DATE, v, 104)     -- 10.07.2026
                   WHEN v LIKE N''[0-9]%/[0-9]%/[0-9][0-9][0-9][0-9]'' THEN TRY_CONVERT(DATE, v, 103)     -- 10/07/2026
                   WHEN v LIKE N''[0-9]%-[0-9]%-[0-9][0-9][0-9][0-9]'' THEN TRY_CONVERT(DATE, v, 105)     -- 10-07-2026
                   WHEN v LIKE N''[0-9][0-9][0-9][0-9]/[0-9]%'' THEN TRY_CONVERT(DATE, v, 111)             -- 2026/07/10
                   WHEN v LIKE N''[0-9][0-9][0-9][0-9].[0-9]%'' THEN TRY_CONVERT(DATE, v, 102)             -- 2026.07.10
               END
        FROM (SELECT id, NULLIF(LTRIM(RTRIM(CAST(' + QUOTENAME(@col) + N' AS NVARCHAR(200)))), N'''') AS v
              FROM ' + QUOTENAME(@tbl) + N') s
        WHERE v IS NOT NULL;';
    EXEC sp_executesql @sql, N'@tbl SYSNAME, @col SYSNAME', @tbl = @tbl, @col = @col;
    FETCH NEXT FROM c_read INTO @tbl, @col;
END
CLOSE c_read; DEALLOCATE c_read;

-- 3. Anything that is not a valid date -> stop and list it.
SELECT @bad = STUFF((
    SELECT N'; ' + tbl + N'.' + col + N' id ' + CAST(id AS NVARCHAR(10)) + N' = "' + raw + N'"'
    FROM #conv WHERE d IS NULL
    ORDER BY tbl, col, id
    FOR XML PATH(''), TYPE).value('.', 'NVARCHAR(MAX)'), 1, 2, N'');
IF @bad IS NOT NULL
BEGIN
    SET @msg = LEFT(N'007 stopped, nothing changed. These values are not a valid date - correct them first: ' + @bad, 2048);
    THROW 50003, @msg, 1;
END

-- 4. Write every date back as YYYY-MM-DD (empty ones as NULL), then change the type.
DECLARE c_write CURSOR LOCAL FAST_FORWARD FOR SELECT tbl, col FROM @cols;
OPEN c_write;
FETCH NEXT FROM c_write INTO @tbl, @col;
WHILE @@FETCH_STATUS = 0
BEGIN
    SET @sql = N'UPDATE ' + QUOTENAME(@tbl) + N' SET ' + QUOTENAME(@col) + N' = NULL
                 WHERE LTRIM(RTRIM(CAST(' + QUOTENAME(@col) + N' AS NVARCHAR(200)))) = N'''';
                 UPDATE t SET ' + QUOTENAME(@col) + N' = CONVERT(NVARCHAR(10), c.d, 23)
                 FROM ' + QUOTENAME(@tbl) + N' t JOIN #conv c ON c.tbl = @tbl AND c.col = @col AND c.id = t.id;
                 ALTER TABLE ' + QUOTENAME(@tbl) + N' ALTER COLUMN ' + QUOTENAME(@col) + N' DATE NULL;';
    EXEC sp_executesql @sql, N'@tbl SYSNAME, @col SYSNAME', @tbl = @tbl, @col = @col;
    FETCH NEXT FROM c_write INTO @tbl, @col;
END
CLOSE c_write; DEALLOCATE c_write;

-- 5. Report.
SELECT x.tbl AS [table], x.col AS [column], ty.name AS now,
       (SELECT COUNT(*) FROM #conv v WHERE v.tbl = x.tbl AND v.col = x.col) AS dates_converted,
       (SELECT COUNT(*) FROM #conv v WHERE v.tbl = x.tbl AND v.col = x.col AND v.raw <> CONVERT(NVARCHAR(10), v.d, 23)) AS format_changed,
       (SELECT CONVERT(NVARCHAR(10), MIN(v.d), 23) + N' .. ' + CONVERT(NVARCHAR(10), MAX(v.d), 23)
        FROM #conv v WHERE v.tbl = x.tbl AND v.col = x.col) AS range
FROM @cols x
JOIN sys.columns c ON c.object_id = OBJECT_ID(x.tbl) AND c.name = x.col
JOIN sys.types ty ON ty.user_type_id = c.user_type_id
ORDER BY x.tbl, x.col;

-- Every value whose text changed, before -> after
SELECT tbl AS [table], col AS [column], id, raw AS [before], CONVERT(NVARCHAR(10), d, 23) AS [after]
FROM #conv WHERE raw <> CONVERT(NVARCHAR(10), d, 23)
ORDER BY tbl, col, id;

DROP TABLE #conv;
