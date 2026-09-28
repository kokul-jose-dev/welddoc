-- 005_material_spec_numbers.sql
--
-- WHAT IT DOES
--   weldoc_global_materials: the specification fields hold only the number from now on.
--     dn1 ... dn6                      text -> INT             "DN 25"     -> 25
--     diameter, diameter2, diameter3   text -> DECIMAL(10,4)   "Ø 33,7 mm" -> 33.7
--     thickness, thickness2, thickness3 text -> DECIMAL(10,4)  "2.0 mm"    -> 2.0
--     surface                          text -> DECIMAL(10,4)   "Ra 0.6 µm" -> 0.6
--     material_code                    text -> DECIMAL(6,4)    "1,454"     -> 1.454
--   The app shows the units again ("DN 25", "Ø 33.7 mm", "2.0 mm", "Ra 0.6 µm", "1.4540").
--
-- REQUIRES
--   The app version with app/spec_values.py must be running first. It reads both the old
--   text and the new numbers and writes plain numbers, so it works before and after this.
--
-- DATA
--   Every value keeps its meaning; only the unit text around it is removed ("DN", "Ra",
--   "Ø", "mm", "µm", spaces) and a decimal comma becomes a point. Nothing is deleted.
--   If ANY value cannot be read as a number (or has more than 4 decimals, or a DN that is
--   not a whole number) the script STOPS, changes nothing and lists those values - they are
--   corrected by hand first, then the script is run again.
--   At the end it reports catalogue entries that have become identical (e.g. "2 mm" and
--   "2.0" are now the same number). They are only reported, not merged.
--
-- Only these columns of weldoc_global_materials are changed.

SET XACT_ABORT ON;
SET NOCOUNT ON;

DECLARE @cols TABLE (col SYSNAME PRIMARY KEY, kind VARCHAR(10), target NVARCHAR(30));
INSERT @cols (col, kind, target) VALUES
    ('dn1', 'int', N'INT'), ('dn2', 'int', N'INT'), ('dn3', 'int', N'INT'),
    ('dn4', 'int', N'INT'), ('dn5', 'int', N'INT'), ('dn6', 'int', N'INT'),
    ('diameter',  'dec', N'DECIMAL(10,4)'), ('diameter2',  'dec', N'DECIMAL(10,4)'), ('diameter3',  'dec', N'DECIMAL(10,4)'),
    ('thickness', 'dec', N'DECIMAL(10,4)'), ('thickness2', 'dec', N'DECIMAL(10,4)'), ('thickness3', 'dec', N'DECIMAL(10,4)'),
    ('surface',   'dec', N'DECIMAL(10,4)'),
    ('material_code', 'code', N'DECIMAL(6,4)');

DECLARE @sql NVARCHAR(MAX), @msg NVARCHAR(2048), @col SYSNAME, @kind VARCHAR(10), @target NVARCHAR(30), @bad NVARCHAR(MAX);

-- 1. Every column must exist. Columns that are already numbers are skipped (so running
--    this again, or on a database that already has it, does nothing).
SELECT @msg = STUFF((SELECT N', ' + x.col FROM @cols x
                     WHERE COL_LENGTH('weldoc_global_materials', x.col) IS NULL
                     FOR XML PATH(''), TYPE).value('.', 'NVARCHAR(MAX)'), 1, 2, N'');
IF @msg IS NOT NULL
BEGIN
    SET @msg = N'005 stopped, nothing changed: weldoc_global_materials has no column(s) ' + @msg;
    THROW 50001, @msg, 1;
END

DELETE x FROM @cols x
JOIN sys.columns c ON c.object_id = OBJECT_ID('weldoc_global_materials') AND c.name = x.col
JOIN sys.types ty ON ty.user_type_id = c.user_type_id
WHERE ty.name NOT IN ('varchar', 'nvarchar', 'char', 'nchar');

-- Nothing may depend on these columns (an index or constraint would block the type change)
IF EXISTS (
    SELECT 1 FROM sys.index_columns ic
    JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
    JOIN @cols x ON x.col = c.name
    WHERE ic.object_id = OBJECT_ID('weldoc_global_materials'))
OR EXISTS (
    SELECT 1 FROM sys.default_constraints dc
    JOIN sys.columns c ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id
    JOIN @cols x ON x.col = c.name
    WHERE dc.parent_object_id = OBJECT_ID('weldoc_global_materials'))
OR EXISTS (
    SELECT 1 FROM sys.check_constraints cc
    JOIN sys.columns c ON c.object_id = cc.parent_object_id AND c.column_id = cc.parent_column_id
    JOIN @cols x ON x.col = c.name
    WHERE cc.parent_object_id = OBJECT_ID('weldoc_global_materials'))
    THROW 50002, N'005 stopped, nothing changed: an index or constraint uses one of the specification columns.', 1;

-- 2. Read every value into a work table: the raw text, and the bare number that is left
--    once the unit text is removed. Same rules as _clean() in app/spec_values.py.
CREATE TABLE #conv (id INT, col SYSNAME, kind VARCHAR(10), raw NVARCHAR(200), num NVARCHAR(200));

DECLARE c_read CURSOR LOCAL FAST_FORWARD FOR SELECT col, kind FROM @cols;
OPEN c_read;
FETCH NEXT FROM c_read INTO @col, @kind;
WHILE @@FETCH_STATUS = 0
BEGIN
    SET @sql = N'
        INSERT #conv (id, col, kind, raw, num)
        SELECT id, @col, @kind, v, n
        FROM (
            SELECT id, CAST(' + QUOTENAME(@col) + N' AS NVARCHAR(200)) AS v
            FROM weldoc_global_materials WHERE ' + QUOTENAME(@col) + N' IS NOT NULL
        ) src
        CROSS APPLY (SELECT LTRIM(RTRIM(v)) AS t) a
        CROSS APPLY (SELECT CASE WHEN LEFT(a.t, 2) IN (N''DN'', N''RA'') THEN SUBSTRING(a.t, 3, 200) ELSE a.t END AS t) b
        CROSS APPLY (SELECT REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
                            b.t, N''µm'', N''''), N''μm'', N''''), N''um'', N''''), N''mm'', N''''),
                            N''Ø'', N''''), N''⌀'', N''''), N'' '', N''''), N'','', N''.'') AS n) d;';
    EXEC sp_executesql @sql, N'@col SYSNAME, @kind VARCHAR(10)', @col = @col, @kind = @kind;
    FETCH NEXT FROM c_read INTO @col, @kind;
END
CLOSE c_read; DEALLOCATE c_read;

-- Empty stays empty
UPDATE #conv SET num = NULL WHERE num = N'';

-- 3. Anything that is not a clean number -> stop and list it.
SELECT @bad = STUFF((
    SELECT N'; ' + col + N' id ' + CAST(id AS NVARCHAR(10)) + N' = "' + raw + N'"'
    FROM #conv
    WHERE num IS NOT NULL AND (
           num LIKE N'%[^0-9.]%'                                   -- a character that is not a digit or point
        OR num LIKE N'%.%.%' OR num LIKE N'.%' OR num LIKE N'%.'   -- not exactly one well-placed point
        OR (CHARINDEX(N'.', num) > 0 AND LEN(num) - CHARINDEX(N'.', num) > 4)   -- more than 4 decimals
        OR (kind = 'int'  AND num LIKE N'%.%[1-9]%')                -- DN with a real fraction
        OR (kind = 'int'  AND TRY_CAST(num AS DECIMAL(18,4)) = 0)   -- DN 0
        OR (kind = 'code' AND TRY_CAST(num AS DECIMAL(18,4)) >= 100)
        OR (kind = 'dec'  AND TRY_CAST(num AS DECIMAL(18,4)) >= 1000000)
        OR TRY_CAST(num AS DECIMAL(18,4)) IS NULL)
    ORDER BY col, id
    FOR XML PATH(''), TYPE).value('.', 'NVARCHAR(MAX)'), 1, 2, N'');
IF @bad IS NOT NULL
BEGIN
    SET @msg = LEFT(N'005 stopped, nothing changed. These values are not a plain number - correct them first: ' + @bad, 2048);
    THROW 50003, @msg, 1;
END

-- 4. Write the bare numbers back, then change each column's type.
DECLARE c_write CURSOR LOCAL FAST_FORWARD FOR SELECT col, kind, target FROM @cols;
OPEN c_write;
FETCH NEXT FROM c_write INTO @col, @kind, @target;
WHILE @@FETCH_STATUS = 0
BEGIN
    SET @sql = N'
        UPDATE g SET ' + QUOTENAME(@col) + N' =
            CASE WHEN @kind = ''int'' THEN CAST(CAST(CAST(c.num AS DECIMAL(18,4)) AS INT) AS NVARCHAR(20)) ELSE c.num END
        FROM weldoc_global_materials g
        JOIN #conv c ON c.id = g.id AND c.col = @col;
        UPDATE g SET ' + QUOTENAME(@col) + N' = NULL
        FROM weldoc_global_materials g
        JOIN #conv c ON c.id = g.id AND c.col = @col AND c.num IS NULL;
        ALTER TABLE weldoc_global_materials ALTER COLUMN ' + QUOTENAME(@col) + N' ' + @target + N' NULL;';
    EXEC sp_executesql @sql, N'@col SYSNAME, @kind VARCHAR(10)', @col = @col, @kind = @kind;
    FETCH NEXT FROM c_write INTO @col, @kind, @target;
END
CLOSE c_write; DEALLOCATE c_write;

-- 5. Report: what each column is now, and how many values were converted.
SELECT x.col AS [column],
       ty.name + CASE WHEN ty.name = 'decimal' THEN '(' + CAST(c.precision AS VARCHAR(5)) + ',' + CAST(c.scale AS VARCHAR(5)) + ')' ELSE '' END AS now,
       (SELECT COUNT(*) FROM #conv v WHERE v.col = x.col AND v.num IS NOT NULL) AS values_converted,
       (SELECT COUNT(*) FROM #conv v WHERE v.col = x.col AND v.num IS NOT NULL AND v.raw <> v.num) AS unit_text_removed
FROM @cols x
JOIN sys.columns c ON c.object_id = OBJECT_ID('weldoc_global_materials') AND c.name = x.col
JOIN sys.types ty ON ty.user_type_id = c.user_type_id
ORDER BY x.col;

-- Every value whose text changed, before -> after (for a final look)
SELECT col AS [column], id, raw AS [before], num AS [after]
FROM #conv WHERE num IS NOT NULL AND raw <> num
ORDER BY col, id;

-- Active catalogue entries that are now identical (reported only). Rows with the same
-- same_as value describe the same material; same_as is the oldest of them.
SELECT same_as, id, category, item_description
FROM (
    SELECT g.id, g.category, g.item_description,
           COUNT(*) OVER (PARTITION BY k.spec) AS n,
           MIN(g.id) OVER (PARTITION BY k.spec) AS same_as
    FROM weldoc_global_materials g
    CROSS APPLY (SELECT CONCAT(
        LOWER(LTRIM(RTRIM(ISNULL(g.category, '')))), '|', LOWER(LTRIM(RTRIM(ISNULL(g.item_description, '')))), '|',
        LOWER(LTRIM(RTRIM(ISNULL(g.dien_no, '')))), '|',
        g.dn1, '|', g.dn2, '|', g.dn3, '|', g.dn4, '|', g.dn5, '|', g.dn6, '|',
        g.diameter, '|', g.diameter2, '|', g.diameter3, '|',
        g.thickness, '|', g.thickness2, '|', g.thickness3, '|',
        g.surface, '|', g.material_code) AS spec) k
    WHERE g.archived = 0
) t
WHERE n > 1
ORDER BY same_as, id;

DROP TABLE #conv;
