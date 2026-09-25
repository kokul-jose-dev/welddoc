-- 01_schema_overview.sql  (READ-ONLY)
-- Describes the database as it really is, so the migration files can be written for the
-- actual structure rather than for what schema.sql or the Python models claim.
-- Run it on local AND production and compare the two outputs.
--
--   weldoc\venv\Scripts\python db\run_check.py db\checks\01_schema_overview.sql

SET NOCOUNT ON;

-- 1. Every table in the database, with its row count. Tables NOT starting with weldoc_
--    belong to another application sharing this database - migrations must never touch them.
SELECT s.name AS [schema], t.name AS [table],
       CASE WHEN t.name LIKE 'weldoc[_]%' THEN 'weldoc' ELSE 'OTHER APP' END AS owner,
       SUM(p.rows) AS row_count
FROM sys.tables t
JOIN sys.schemas s ON s.schema_id = t.schema_id
JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
GROUP BY s.name, t.name
ORDER BY owner DESC, t.name;

-- 2. Columns of the weldoc tables: type, size, NULL allowed, and any DEFAULT in the database.
--    (default = NULL here means the only default is the Python one in the models.)
SELECT t.name AS [table], c.column_id AS pos, c.name AS [column],
       ty.name + CASE
           WHEN ty.name IN ('nvarchar', 'nchar') THEN '(' + CASE WHEN c.max_length = -1 THEN 'MAX' ELSE CAST(c.max_length / 2 AS VARCHAR(10)) END + ')'
           WHEN ty.name IN ('varchar', 'char')   THEN '(' + CASE WHEN c.max_length = -1 THEN 'MAX' ELSE CAST(c.max_length AS VARCHAR(10)) END + ')'
           ELSE '' END AS [type],
       CASE WHEN c.is_nullable = 1 THEN 'NULL' ELSE 'NOT NULL' END AS nullable,
       CASE WHEN c.is_identity = 1 THEN 'IDENTITY' ELSE '' END AS ident,
       dc.name AS default_name,
       dc.definition AS [default]
FROM sys.tables t
JOIN sys.columns c ON c.object_id = t.object_id
JOIN sys.types ty ON ty.user_type_id = c.user_type_id
LEFT JOIN sys.default_constraints dc ON dc.parent_object_id = t.object_id AND dc.parent_column_id = c.column_id
WHERE t.name LIKE 'weldoc[_]%'
ORDER BY t.name, c.column_id;

-- 3. Indexes on the weldoc tables. Needed because SQL Server refuses to change a column
--    (e.g. NULL -> NOT NULL) while an index uses it: those indexes must be dropped and
--    recreated around the change, under their real names.
SELECT t.name AS [table], i.name AS [index], i.type_desc AS kind,
       CASE WHEN i.is_primary_key = 1 THEN 'PK' WHEN i.is_unique = 1 THEN 'UNIQUE' ELSE '' END AS [unique],
       STUFF((SELECT ', ' + c.name
              FROM sys.index_columns ic
              JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
              WHERE ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
              ORDER BY ic.key_ordinal
              FOR XML PATH('')), 1, 2, '') AS [columns],
       i.filter_definition AS [filter]
FROM sys.indexes i
JOIN sys.tables t ON t.object_id = i.object_id
WHERE t.name LIKE 'weldoc[_]%' AND i.type > 0
ORDER BY t.name, i.name;

-- 4. Foreign keys between the weldoc tables, with their real names and delete rule.
SELECT fk.name AS foreign_key,
       tp.name + '.' + cp.name AS from_column,
       tr.name + '.' + cr.name AS to_column,
       fk.delete_referential_action_desc AS on_delete
FROM sys.foreign_keys fk
JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
JOIN sys.tables tp ON tp.object_id = fkc.parent_object_id
JOIN sys.columns cp ON cp.object_id = fkc.parent_object_id AND cp.column_id = fkc.parent_column_id
JOIN sys.tables tr ON tr.object_id = fkc.referenced_object_id
JOIN sys.columns cr ON cr.object_id = fkc.referenced_object_id AND cr.column_id = fkc.referenced_column_id
WHERE tp.name LIKE 'weldoc[_]%'
ORDER BY tp.name, fk.name;

-- 5. Columns the Python models expect that this database does NOT have (or vice versa is
--    visible in result 2). Keep this list in step with weldoc/app/models/.
SELECT e.[table], e.[column] AS missing_column
FROM (VALUES
    ('weldoc_global_materials', 'diameter2'), ('weldoc_global_materials', 'diameter3'),
    ('weldoc_global_materials', 'thickness2'), ('weldoc_global_materials', 'thickness3'),
    ('weldoc_welders', 'signature_url'),
    ('weldoc_pipeline_materials', 'waz_package_url'),
    ('weldoc_pipelines', 'welding_start'), ('weldoc_pipelines', 'welding_end'), ('weldoc_pipelines', 'welding_remarks'),
    ('weldoc_welds', 'welder_id'), ('weldoc_welds', 'inspector_id'), ('weldoc_welds', 'visual'), ('weldoc_welds', 'endoscopy'),
    ('weldoc_wps_processes', 'wps_no'), ('weldoc_wps_processes', 'process')
) AS e([table], [column])
WHERE COL_LENGTH(e.[table], e.[column]) IS NULL;
