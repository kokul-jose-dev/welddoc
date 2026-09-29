-- 008_dropdown_hidden_values.sql
--
-- WHAT IT DOES
--   Creates weldoc_dropdown_hidden: the dropdown values a user has hidden with the x next to
--   a dropdown (e.g. a mistyped "DN 30"). A hidden value is no longer offered in the
--   material dropdowns; materials that already use it keep it and still show it.
--     type        dn | diameter | thickness | surface | material_code | dien_no
--                 (DN 1-6 share "dn", diameter 1-3 "diameter", thickness 1-3 "thickness")
--     value       the value as the dropdown shows it, e.g. "DN 30", "2.0 mm", "DIN 11865"
--     hidden_by   who hid it (e-mail from the login)
--     hidden_at   when (UTC)
--   Only hidden values are stored: everything not in this table is shown as before.
--
-- DATA
--   New, empty table. No existing table or data is touched.
--   The app's startup (db.create_all) may already have created the table from the model:
--   while empty it is replaced by the definition here; if it already holds rows, only the
--   missing rules below are added.

SET XACT_ABORT ON;
SET NOCOUNT ON;

-- A table the app created by itself at startup (db.create_all) has plain varchar columns and
-- generated names. While it is still empty it is simply replaced by the definition below.
IF OBJECT_ID('weldoc_dropdown_hidden', 'U') IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM weldoc_dropdown_hidden)
   AND OBJECT_ID('DF_weldoc_dropdown_hidden_at', 'D') IS NULL
    DROP TABLE weldoc_dropdown_hidden;

IF OBJECT_ID('weldoc_dropdown_hidden', 'U') IS NULL
BEGIN
    CREATE TABLE weldoc_dropdown_hidden (
        id         INT IDENTITY(1, 1) NOT NULL CONSTRAINT PK_weldoc_dropdown_hidden PRIMARY KEY,
        [type]     NVARCHAR(30)  NOT NULL,
        [value]    NVARCHAR(200) NOT NULL,
        hidden_by  NVARCHAR(200) NULL,
        hidden_at  DATETIME2(0)  NOT NULL CONSTRAINT DF_weldoc_dropdown_hidden_at DEFAULT SYSUTCDATETIME()
    );
END

-- One row per type + value (the default collation compares without case)
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID('weldoc_dropdown_hidden') AND is_unique = 1 AND is_primary_key = 0)
    ALTER TABLE weldoc_dropdown_hidden ADD CONSTRAINT UQ_weldoc_dropdown_hidden_type_value UNIQUE ([type], [value]);

IF OBJECT_ID('CK_weldoc_dropdown_hidden_type', 'C') IS NULL
    ALTER TABLE weldoc_dropdown_hidden WITH CHECK ADD CONSTRAINT CK_weldoc_dropdown_hidden_type
        CHECK ([type] IN ('dn', 'diameter', 'thickness', 'surface', 'material_code', 'dien_no'));

-- Report
SELECT c.name AS [column], ty.name AS [type], CASE WHEN c.is_nullable = 1 THEN 'NULL' ELSE 'NOT NULL' END AS nullable
FROM sys.columns c JOIN sys.types ty ON ty.user_type_id = c.user_type_id
WHERE c.object_id = OBJECT_ID('weldoc_dropdown_hidden')
ORDER BY c.column_id;

SELECT name AS [rule] FROM sys.objects
WHERE parent_object_id = OBJECT_ID('weldoc_dropdown_hidden') AND type IN ('PK', 'UQ', 'C', 'D')
ORDER BY name;
