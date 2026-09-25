-- 001_flags_not_null.sql
--
-- WHAT IT DOES
--   Makes the yes/no flags of the weldoc tables impossible to leave empty:
--     archived               on every weldoc table the app uses
--     start_of_plumbing,
--     end_of_plumbing        on weldoc_pipeline_materials
--   Each gets DEFAULT 0 (if it has no default yet) and becomes NOT NULL.
--
-- WHY
--   A row whose archived is NULL is invisible: the app lists archived = 0 or archived = 1,
--   and NULL is neither. NOT NULL makes that impossible.
--
-- DATA
--   No row is deleted, no archived value is changed.
--   - If any row has archived = NULL, the script STOPS and changes nothing: whether such a
--     row should come back (0) or stay hidden (1) is a decision for a person.
--   - start_of_plumbing / end_of_plumbing NULL are set to 0. The app already reads NULL as
--     "no", so nothing changes in what anyone sees.
--
-- HOW
--   SQL Server refuses to change a column while an index uses it, so the indexes that use
--   these columns are recorded, dropped, and recreated exactly as they were. All names are
--   looked up in the database itself - index and constraint names differ between databases.
--   The whole file runs in one transaction: any error undoes everything.

SET XACT_ABORT ON;
SET NOCOUNT ON;

DECLARE @cols TABLE (tbl SYSNAME, col SYSNAME, fill_nulls BIT);
INSERT @cols (tbl, col, fill_nulls) VALUES
    ('weldoc_clients',            'archived',          0),
    ('weldoc_projects',           'archived',          0),
    ('weldoc_pipelines',          'archived',          0),
    ('weldoc_global_materials',   'archived',          0),
    ('weldoc_project_materials',  'archived',          0),
    ('weldoc_pipeline_materials', 'archived',          0),
    ('weldoc_pipeline_materials', 'start_of_plumbing', 1),
    ('weldoc_pipeline_materials', 'end_of_plumbing',   1),
    ('weldoc_welds',              'archived',          0),
    ('weldoc_welders',            'archived',          0),
    ('weldoc_weldercertificate',  'archived',          0),
    ('weldoc_users',              'archived',          0),
    ('weldoc_wps_processes',      'archived',          0);

DECLARE @sql NVARCHAR(MAX), @msg NVARCHAR(2048), @tbl SYSNAME, @col SYSNAME, @fill BIT, @n INT;

-- 1. Every listed column must exist and be a bit column; otherwise this database is not
--    what the script was written for, and it stops.
SELECT @msg = STUFF((
    SELECT N', ' + x.tbl + N'.' + x.col
    FROM @cols x
    LEFT JOIN sys.columns c ON c.object_id = OBJECT_ID(x.tbl) AND c.name = x.col
    LEFT JOIN sys.types ty ON ty.user_type_id = c.user_type_id
    WHERE c.column_id IS NULL OR ty.name <> 'bit'
    FOR XML PATH(''), TYPE).value('.', 'NVARCHAR(MAX)'), 1, 2, N'');
IF @msg IS NOT NULL
BEGIN
    SET @msg = N'001 stopped, nothing changed: missing or not a bit column: ' + @msg;
    THROW 50001, @msg, 1;
END

-- Only work on the columns that still allow NULL (running on an already fixed database
-- therefore does nothing).
DELETE x FROM @cols x
JOIN sys.columns c ON c.object_id = OBJECT_ID(x.tbl) AND c.name = x.col
WHERE c.is_nullable = 0;

-- 2. archived = NULL anywhere -> stop (see DATA above). Plumbing flags NULL -> 0.
DECLARE c_cols CURSOR LOCAL FAST_FORWARD FOR SELECT tbl, col, fill_nulls FROM @cols;
OPEN c_cols;
FETCH NEXT FROM c_cols INTO @tbl, @col, @fill;
WHILE @@FETCH_STATUS = 0
BEGIN
    IF @fill = 1
    BEGIN
        SET @sql = N'UPDATE ' + QUOTENAME(@tbl) + N' SET ' + QUOTENAME(@col) + N' = 0 WHERE ' + QUOTENAME(@col) + N' IS NULL;';
        EXEC sp_executesql @sql;
    END
    ELSE
    BEGIN
        SET @sql = N'SELECT @n = COUNT(*) FROM ' + QUOTENAME(@tbl) + N' WHERE ' + QUOTENAME(@col) + N' IS NULL;';
        EXEC sp_executesql @sql, N'@n INT OUTPUT', @n = @n OUTPUT;
        IF @n > 0
        BEGIN
            SET @msg = N'001 stopped, nothing changed: ' + CAST(@n AS NVARCHAR(10)) + N' row(s) in ' + @tbl
                     + N' have ' + @col + N' = NULL. Decide per row whether it should be 0 (visible) or 1 (archived), set it, then run again.';
            THROW 50002, @msg, 1;
        END
    END
    FETCH NEXT FROM c_cols INTO @tbl, @col, @fill;
END
CLOSE c_cols; DEALLOCATE c_cols;

-- 3. Record the indexes that use these columns, so they can be recreated identically.
--    A primary key or unique constraint on one of them is not expected and stops the script.
IF EXISTS (
    SELECT 1 FROM sys.indexes i
    JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
    JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
    JOIN @cols x ON OBJECT_ID(x.tbl) = i.object_id AND x.col = c.name
    WHERE i.is_primary_key = 1 OR i.is_unique_constraint = 1 OR i.type <> 2)
    THROW 50003, N'001 stopped, nothing changed: a primary key, unique constraint or clustered index uses one of these columns.', 1;

DECLARE @idx TABLE (tbl SYSNAME, idx SYSNAME, is_unique BIT, key_cols NVARCHAR(MAX), incl_cols NVARCHAR(MAX), filter_def NVARCHAR(MAX));
INSERT @idx (tbl, idx, is_unique, key_cols, incl_cols, filter_def)
SELECT DISTINCT OBJECT_NAME(i.object_id), i.name, i.is_unique,
    STUFF((SELECT N', ' + QUOTENAME(c2.name) + CASE WHEN ic2.is_descending_key = 1 THEN N' DESC' ELSE N'' END
           FROM sys.index_columns ic2
           JOIN sys.columns c2 ON c2.object_id = ic2.object_id AND c2.column_id = ic2.column_id
           WHERE ic2.object_id = i.object_id AND ic2.index_id = i.index_id AND ic2.is_included_column = 0
           ORDER BY ic2.key_ordinal
           FOR XML PATH(''), TYPE).value('.', 'NVARCHAR(MAX)'), 1, 2, N''),
    STUFF((SELECT N', ' + QUOTENAME(c2.name)
           FROM sys.index_columns ic2
           JOIN sys.columns c2 ON c2.object_id = ic2.object_id AND c2.column_id = ic2.column_id
           WHERE ic2.object_id = i.object_id AND ic2.index_id = i.index_id AND ic2.is_included_column = 1
           ORDER BY ic2.index_column_id
           FOR XML PATH(''), TYPE).value('.', 'NVARCHAR(MAX)'), 1, 2, N''),
    i.filter_definition
FROM sys.indexes i
JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
JOIN @cols x ON OBJECT_ID(x.tbl) = i.object_id AND x.col = c.name
WHERE i.type = 2;   -- nonclustered

-- 4. Drop those indexes.
DECLARE @idxname SYSNAME, @uniq BIT, @keys NVARCHAR(MAX), @incl NVARCHAR(MAX), @filter NVARCHAR(MAX);
DECLARE c_drop CURSOR LOCAL FAST_FORWARD FOR SELECT tbl, idx FROM @idx;
OPEN c_drop;
FETCH NEXT FROM c_drop INTO @tbl, @idxname;
WHILE @@FETCH_STATUS = 0
BEGIN
    SET @sql = N'DROP INDEX ' + QUOTENAME(@idxname) + N' ON ' + QUOTENAME(@tbl) + N';';
    EXEC sp_executesql @sql;
    FETCH NEXT FROM c_drop INTO @tbl, @idxname;
END
CLOSE c_drop; DEALLOCATE c_drop;

-- 5. Add DEFAULT 0 where the column has none, then make it NOT NULL.
DECLARE c_alter CURSOR LOCAL FAST_FORWARD FOR SELECT tbl, col FROM @cols;
OPEN c_alter;
FETCH NEXT FROM c_alter INTO @tbl, @col;
WHILE @@FETCH_STATUS = 0
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM sys.default_constraints dc
        JOIN sys.columns c ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id
        WHERE dc.parent_object_id = OBJECT_ID(@tbl) AND c.name = @col)
    BEGIN
        SET @sql = N'ALTER TABLE ' + QUOTENAME(@tbl) + N' ADD CONSTRAINT ' + QUOTENAME(N'DF_' + @tbl + N'_' + @col)
                 + N' DEFAULT 0 FOR ' + QUOTENAME(@col) + N';';
        EXEC sp_executesql @sql;
    END
    SET @sql = N'ALTER TABLE ' + QUOTENAME(@tbl) + N' ALTER COLUMN ' + QUOTENAME(@col) + N' BIT NOT NULL;';
    EXEC sp_executesql @sql;
    FETCH NEXT FROM c_alter INTO @tbl, @col;
END
CLOSE c_alter; DEALLOCATE c_alter;

-- 6. Recreate the indexes exactly as recorded.
DECLARE c_create CURSOR LOCAL FAST_FORWARD FOR SELECT tbl, idx, is_unique, key_cols, incl_cols, filter_def FROM @idx;
OPEN c_create;
FETCH NEXT FROM c_create INTO @tbl, @idxname, @uniq, @keys, @incl, @filter;
WHILE @@FETCH_STATUS = 0
BEGIN
    SET @sql = N'CREATE ' + CASE WHEN @uniq = 1 THEN N'UNIQUE ' ELSE N'' END + N'NONCLUSTERED INDEX '
             + QUOTENAME(@idxname) + N' ON ' + QUOTENAME(@tbl) + N' (' + @keys + N')'
             + CASE WHEN @incl IS NOT NULL THEN N' INCLUDE (' + @incl + N')' ELSE N'' END
             + CASE WHEN @filter IS NOT NULL THEN N' WHERE ' + @filter ELSE N'' END + N';';
    EXEC sp_executesql @sql;
    FETCH NEXT FROM c_create INTO @tbl, @idxname, @uniq, @keys, @incl, @filter;
END
CLOSE c_create; DEALLOCATE c_create;

-- 7. Report what was done (shown by the runner / a dry run).
SELECT x.tbl AS [table], x.col AS [column],
       CASE WHEN c.is_nullable = 0 THEN 'NOT NULL' ELSE 'still NULL!' END AS now,
       dc.definition AS [default]
FROM @cols x
JOIN sys.columns c ON c.object_id = OBJECT_ID(x.tbl) AND c.name = x.col
LEFT JOIN sys.default_constraints dc ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id
ORDER BY x.tbl, x.col;

SELECT tbl AS [table], idx AS index_recreated, key_cols AS [columns] FROM @idx ORDER BY tbl, idx;
