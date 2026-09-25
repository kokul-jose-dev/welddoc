-- 004_order_no_length.sql
--
-- WHAT IT DOES
--   weldoc_projects.order_no  varchar(50)  ->  nvarchar(100)
--   Longer (100 characters, as the app allows) and Unicode (special characters kept).
--
-- WHY
--   The app accepts up to 100 characters, the database only 50: a longer order number made
--   the whole project save fail with a server error.
--
-- DATA
--   Every existing order number stays exactly as it is - widening a column never cuts or
--   changes a value. The column keeps its current collation (sort / compare rules) and
--   still allows empty. If it is already nvarchar(100) or wider, nothing happens.
--
-- Only weldoc_projects.order_no is changed.

SET XACT_ABORT ON;
SET NOCOUNT ON;

DECLARE @type SYSNAME, @chars INT, @collation SYSNAME, @nullable BIT, @sql NVARCHAR(MAX);

SELECT @type = ty.name,
       @chars = CASE WHEN c.max_length = -1 THEN 2147483647
                     WHEN ty.name IN ('nvarchar', 'nchar') THEN c.max_length / 2
                     ELSE c.max_length END,
       @collation = c.collation_name,
       @nullable = c.is_nullable
FROM sys.columns c
JOIN sys.types ty ON ty.user_type_id = c.user_type_id
WHERE c.object_id = OBJECT_ID('weldoc_projects') AND c.name = 'order_no';

-- 1. The column must exist and be text; otherwise stop.
IF @type IS NULL
    THROW 50001, N'004 stopped, nothing changed: weldoc_projects.order_no not found.', 1;
IF @type NOT IN ('varchar', 'nvarchar', 'char', 'nchar')
    THROW 50002, N'004 stopped, nothing changed: weldoc_projects.order_no is not a text column.', 1;

-- 2. Nothing may depend on the column (an index or constraint would block the change).
IF EXISTS (SELECT 1 FROM sys.index_columns ic JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
           WHERE ic.object_id = OBJECT_ID('weldoc_projects') AND c.name = 'order_no')
   OR EXISTS (SELECT 1 FROM sys.default_constraints dc JOIN sys.columns c ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id
              WHERE dc.parent_object_id = OBJECT_ID('weldoc_projects') AND c.name = 'order_no')
   OR EXISTS (SELECT 1 FROM sys.check_constraints cc JOIN sys.columns c ON c.object_id = cc.parent_object_id AND c.column_id = cc.parent_column_id
              WHERE cc.parent_object_id = OBJECT_ID('weldoc_projects') AND c.name = 'order_no')
    THROW 50003, N'004 stopped, nothing changed: an index or constraint uses weldoc_projects.order_no.', 1;

-- 3. Widen, unless it is already Unicode and at least 100 characters.
IF NOT (@type = 'nvarchar' AND @chars >= 100)
BEGIN
    SET @sql = N'ALTER TABLE weldoc_projects ALTER COLUMN order_no NVARCHAR(100) COLLATE ' + @collation
             + CASE WHEN @nullable = 1 THEN N' NULL;' ELSE N' NOT NULL;' END;
    EXEC sp_executesql @sql;
END

-- 4. Report.
SELECT c.name AS [column],
       ty.name + '(' + CASE WHEN c.max_length = -1 THEN 'MAX' ELSE CAST(c.max_length / 2 AS VARCHAR(10)) END + ')' AS [type],
       CASE WHEN c.is_nullable = 1 THEN 'NULL' ELSE 'NOT NULL' END AS nullable,
       c.collation_name AS collation,
       (SELECT COUNT(*) FROM weldoc_projects WHERE order_no IS NOT NULL AND order_no <> '') AS projects_with_order_no,
       (SELECT MAX(LEN(order_no)) FROM weldoc_projects) AS longest_now
FROM sys.columns c
JOIN sys.types ty ON ty.user_type_id = c.user_type_id
WHERE c.object_id = OBJECT_ID('weldoc_projects') AND c.name = 'order_no';
