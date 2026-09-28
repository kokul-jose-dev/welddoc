-- 006_whole_numbers.sql
--
-- WHAT IT DOES
--   These columns hold a real whole number from now on instead of text:
--     weldoc_welds.weld_no            text -> INT        "14"     -> 14
--     weldoc_welds.procedure          text -> INT        "141"    -> 141
--     weldoc_projects.ist_project_no  text -> INT        "926786" -> 926786   (may be empty)
--   The app shows them exactly as before; numbers now sort as numbers (2 before 10).
--
-- REQUIRES
--   The app version with WholeNumberColumn in app/spec_values.py must be running first. It
--   reads both the old text and the new numbers, so it works before and after this file.
--
-- DATA
--   Every value keeps its meaning; surrounding spaces are removed and an empty value becomes
--   empty (NULL) - also an empty IST project number, which is allowed (decided 2026-09-28).
--   Nothing is deleted.
--   If ANY value is not a plain whole number (e.g. "3R", "12a") the script STOPS, changes
--   nothing and lists those values.
--   Note: a whole number cannot keep a leading zero - "0123" would become 123. The script
--   stops on such values too, so nobody's number changes without being seen first.
--
-- Only these three columns are changed.

SET XACT_ABORT ON;
SET NOCOUNT ON;

DECLARE @cols TABLE (tbl SYSNAME, col SYSNAME, required BIT, PRIMARY KEY (tbl, col));
INSERT @cols (tbl, col, required) VALUES
    ('weldoc_welds',    'weld_no',        0),
    ('weldoc_welds',    'procedure',      0),
    ('weldoc_projects', 'ist_project_no', 0);

DECLARE @sql NVARCHAR(MAX), @msg NVARCHAR(2048), @tbl SYSNAME, @col SYSNAME, @req BIT, @bad NVARCHAR(MAX);

-- 1. Every column must exist; columns that are already numbers are skipped.
SELECT @msg = STUFF((SELECT N', ' + x.tbl + N'.' + x.col FROM @cols x
                     WHERE COL_LENGTH(x.tbl, x.col) IS NULL
                     FOR XML PATH(''), TYPE).value('.', 'NVARCHAR(MAX)'), 1, 2, N'');
IF @msg IS NOT NULL
BEGIN
    SET @msg = N'006 stopped, nothing changed: column(s) not found: ' + @msg;
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
    THROW 50002, N'006 stopped, nothing changed: an index or constraint uses one of these columns.', 1;

-- 2. Read every value: raw text and the trimmed number.
CREATE TABLE #conv (tbl SYSNAME, col SYSNAME, required BIT, id INT, raw NVARCHAR(200), num NVARCHAR(200));

DECLARE c_read CURSOR LOCAL FAST_FORWARD FOR SELECT tbl, col, required FROM @cols;
OPEN c_read;
FETCH NEXT FROM c_read INTO @tbl, @col, @req;
WHILE @@FETCH_STATUS = 0
BEGIN
    SET @sql = N'INSERT #conv (tbl, col, required, id, raw, num)
                 SELECT @tbl, @col, @req, id, CAST(' + QUOTENAME(@col) + N' AS NVARCHAR(200)),
                        NULLIF(LTRIM(RTRIM(CAST(' + QUOTENAME(@col) + N' AS NVARCHAR(200)))), N'''')
                 FROM ' + QUOTENAME(@tbl) + N';';
    EXEC sp_executesql @sql, N'@tbl SYSNAME, @col SYSNAME, @req BIT', @tbl = @tbl, @col = @col, @req = @req;
    FETCH NEXT FROM c_read INTO @tbl, @col, @req;
END
CLOSE c_read; DEALLOCATE c_read;

-- 3. Anything that is not a plain whole number -> stop and list it.
SELECT @bad = STUFF((
    SELECT N'; ' + tbl + N'.' + col + N' id ' + CAST(id AS NVARCHAR(10)) + N' = "' + ISNULL(raw, N'(empty)') + N'"'
    FROM #conv
    WHERE (num IS NULL AND required = 1)                          -- a required number left empty
       OR (num IS NOT NULL AND (
              num LIKE N'%[^0-9]%'                                -- anything but digits
           OR LEN(num) > 10 OR TRY_CAST(num AS BIGINT) > 2147483647
           OR (LEN(num) > 1 AND LEFT(num, 1) = N'0')))            -- a leading zero would be lost
    ORDER BY tbl, col, id
    FOR XML PATH(''), TYPE).value('.', 'NVARCHAR(MAX)'), 1, 2, N'');
IF @bad IS NOT NULL
BEGIN
    SET @msg = LEFT(N'006 stopped, nothing changed. These values are not a plain whole number - correct them first: ' + @bad, 2048);
    THROW 50003, @msg, 1;
END

-- 4. Write the trimmed numbers back, then change the type.
DECLARE c_write CURSOR LOCAL FAST_FORWARD FOR SELECT tbl, col, required FROM @cols;
OPEN c_write;
FETCH NEXT FROM c_write INTO @tbl, @col, @req;
WHILE @@FETCH_STATUS = 0
BEGIN
    -- A column that may be empty is first allowed to be empty (still as text), so an empty
    -- value can become NULL before the type changes - an empty text would not convert.
    SET @sql = CASE WHEN @req = 0 THEN
                 N'ALTER TABLE ' + QUOTENAME(@tbl) + N' ALTER COLUMN ' + QUOTENAME(@col) + N' NVARCHAR(200) NULL;'
               ELSE N'' END + N'
                 UPDATE t SET ' + QUOTENAME(@col) + N' = c.num
                 FROM ' + QUOTENAME(@tbl) + N' t JOIN #conv c ON c.tbl = @tbl AND c.col = @col AND c.id = t.id;
                 ALTER TABLE ' + QUOTENAME(@tbl) + N' ALTER COLUMN ' + QUOTENAME(@col) + N' INT '
               + CASE WHEN @req = 1 THEN N'NOT NULL' ELSE N'NULL' END + N';';
    EXEC sp_executesql @sql, N'@tbl SYSNAME, @col SYSNAME', @tbl = @tbl, @col = @col;
    FETCH NEXT FROM c_write INTO @tbl, @col, @req;
END
CLOSE c_write; DEALLOCATE c_write;

-- 5. Report.
SELECT x.tbl AS [table], x.col AS [column], ty.name AS now,
       CASE WHEN c.is_nullable = 1 THEN 'NULL' ELSE 'NOT NULL' END AS nullable,
       (SELECT COUNT(*) FROM #conv v WHERE v.tbl = x.tbl AND v.col = x.col AND v.num IS NOT NULL) AS values_converted,
       (SELECT COUNT(*) FROM #conv v WHERE v.tbl = x.tbl AND v.col = x.col AND v.num IS NULL) AS empty
FROM @cols x
JOIN sys.columns c ON c.object_id = OBJECT_ID(x.tbl) AND c.name = x.col
JOIN sys.types ty ON ty.user_type_id = c.user_type_id
ORDER BY x.tbl, x.col;

DROP TABLE #conv;
