-- 012_certificate_number_dien_tidy.sql
--
-- WHAT IT DOES
--   1. weldoc_project_materials.certificate   text -> DECIMAL(3,1)   "3.1" -> 3.1, "3,1" -> 3.1
--      The certificate is always a number with exactly one decimal (EN 10204 types 2.1, 2.2,
--      3.1, ...). The app shows it as "3.1" again (app/spec_values.py, CertificateColumn).
--   2. weldoc_global_materials.dien_no stays text, but is written one way: the norm (DIN, EN,
--      ISO, SN) in capitals, one space, the number - "din 46738" -> "DIN 46738",
--      "DIN2616" -> "DIN 2616". Values without one of these norms in front are left as they are.
--      The same tidy is applied to hidden DIN EN dropdown values (weldoc_dropdown_hidden).
--
-- REQUIRES
--   The app version with CertificateColumn in app/spec_values.py must be running first. It
--   reads both the old text and the new numbers, so it works before and after this file.
--
-- DATA
--   Every certificate keeps its meaning; spaces are removed, a decimal comma becomes a point,
--   an empty certificate becomes empty (NULL). Nothing is deleted.
--   If ANY certificate is not a number with one decimal (e.g. "3", "45", "dsf") the script
--   STOPS, changes nothing and lists those values - they are corrected by hand first.
--   At the end it reports global materials that have become identical through the DIN EN
--   tidy. They are only reported, not merged.
--
-- Only weldoc_project_materials.certificate, weldoc_global_materials.dien_no and the dien_no
-- rows of weldoc_dropdown_hidden are changed.

SET XACT_ABORT ON;
SET NOCOUNT ON;

DECLARE @msg NVARCHAR(2048), @bad NVARCHAR(MAX), @is_text BIT = 0;

-- 1. The certificate column must exist; skipped if it is already a number.
IF COL_LENGTH('weldoc_project_materials', 'certificate') IS NULL
    THROW 51201, N'012 stopped, nothing changed: weldoc_project_materials has no column certificate.', 1;

SELECT @is_text = CASE WHEN ty.name IN ('varchar', 'nvarchar', 'char', 'nchar') THEN 1 ELSE 0 END
FROM sys.columns c JOIN sys.types ty ON ty.user_type_id = c.user_type_id
WHERE c.object_id = OBJECT_ID('weldoc_project_materials') AND c.name = 'certificate';

IF @is_text = 1
BEGIN
    -- Nothing may depend on the column (an index or constraint would block the type change)
    IF EXISTS (SELECT 1 FROM sys.index_columns ic
               JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
               WHERE ic.object_id = OBJECT_ID('weldoc_project_materials') AND c.name = 'certificate')
    OR EXISTS (SELECT 1 FROM sys.default_constraints dc
               JOIN sys.columns c ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id
               WHERE dc.parent_object_id = OBJECT_ID('weldoc_project_materials') AND c.name = 'certificate')
    OR EXISTS (SELECT 1 FROM sys.check_constraints cc
               JOIN sys.columns c ON c.object_id = cc.parent_object_id AND c.column_id = cc.parent_column_id
               WHERE cc.parent_object_id = OBJECT_ID('weldoc_project_materials') AND c.name = 'certificate')
        THROW 51202, N'012 stopped, nothing changed: an index or constraint uses weldoc_project_materials.certificate.', 1;

    -- 2. Read every certificate: the raw text and the clean number (same rule as store_certificate)
    CREATE TABLE #cert (id INT, project_id INT, raw NVARCHAR(200), num NVARCHAR(200));
    EXEC sp_executesql N'
        INSERT #cert (id, project_id, raw, num)
        SELECT id, project_id, CAST(certificate AS NVARCHAR(200)),
               NULLIF(REPLACE(REPLACE(CAST(certificate AS NVARCHAR(200)), N'' '', N''''), N'','', N''.''), N'''')
        FROM weldoc_project_materials WHERE certificate IS NOT NULL;';

    -- 3. Anything that is not a number with one decimal -> stop and list it.
    SELECT @bad = STUFF((
        SELECT N'; project material ' + CAST(c.id AS NVARCHAR(10)) + N' (project ' + ISNULL(CAST(p.ist_project_no AS NVARCHAR(20)), N'-')
               + N' ' + ISNULL(p.title, N'') + N') = "' + c.raw + N'"'
        FROM #cert c LEFT JOIN weldoc_projects p ON p.id = c.project_id
        WHERE c.num IS NOT NULL AND c.num NOT LIKE N'[0-9].[0-9]' AND c.num NOT LIKE N'[0-9][0-9].[0-9]'
        ORDER BY c.id
        FOR XML PATH(''), TYPE).value('.', 'NVARCHAR(MAX)'), 1, 2, N'');
    IF @bad IS NOT NULL
    BEGIN
        SET @msg = LEFT(N'012 stopped, nothing changed. These certificates are not a number with one decimal (e.g. 3.1) - correct them first: ' + @bad, 2048);
        THROW 51203, @msg, 1;
    END

    -- 4. Write the clean numbers back, then change the type.
    EXEC sp_executesql N'
        UPDATE pm SET certificate = c.num
        FROM weldoc_project_materials pm JOIN #cert c ON c.id = pm.id;
        ALTER TABLE weldoc_project_materials ALTER COLUMN certificate DECIMAL(3,1) NULL;';

    SELECT 'certificate' AS [column], 'decimal(3,1)' AS now,
           (SELECT COUNT(*) FROM #cert WHERE num IS NOT NULL) AS values_converted,
           (SELECT COUNT(*) FROM #cert WHERE num IS NULL) AS empty_now_null,
           (SELECT COUNT(*) FROM #cert WHERE num IS NOT NULL AND raw <> num) AS values_tidied;
    DROP TABLE #cert;
END
ELSE
    SELECT 'certificate' AS [column], 'already a number - unchanged' AS now;
GO

SET XACT_ABORT ON;
SET NOCOUNT ON;

-- 5. DIN EN: the norm in capitals, one space, the number (same rule as canon_dien)
CREATE TABLE #norm (norm NVARCHAR(3));
INSERT #norm VALUES (N'DIN'), (N'ISO'), (N'EN'), (N'SN');

CREATE TABLE #dien (id INT, raw NVARCHAR(200), tidy NVARCHAR(200));
INSERT #dien (id, raw, tidy)
SELECT g.id, g.dien_no, x.tidy
FROM weldoc_global_materials g
CROSS APPLY (SELECT LTRIM(RTRIM(g.dien_no)) AS t) a
CROSS APPLY (
    SELECT TOP 1 n.norm + N' ' + LTRIM(SUBSTRING(a.t, LEN(n.norm) + 1, 200)) AS tidy
    FROM #norm n
    WHERE UPPER(LEFT(a.t, LEN(n.norm))) = n.norm
      AND SUBSTRING(a.t, LEN(n.norm) + 1, 1) LIKE N'[0-9 ]'
    ORDER BY LEN(n.norm) DESC) x
WHERE g.dien_no IS NOT NULL;
-- the norm picked AND typed ("DIN DIN 11865") -> once
UPDATE d SET tidy = n.norm + N' ' + LTRIM(SUBSTRING(d.tidy, 2 * LEN(n.norm) + 2, 200))
FROM #dien d JOIN #norm n ON LEFT(d.tidy, 2 * LEN(n.norm) + 1) = n.norm + N' ' + n.norm
WHERE SUBSTRING(d.tidy, 2 * LEN(n.norm) + 2, 1) LIKE N'[0-9 ]';

UPDATE g SET dien_no = d.tidy
FROM weldoc_global_materials g JOIN #dien d ON d.id = g.id
WHERE d.tidy <> d.raw COLLATE Latin1_General_CS_AS;

-- hidden DIN EN dropdown values: the same tidy, unless the tidy value is hidden already
IF OBJECT_ID('weldoc_dropdown_hidden') IS NOT NULL
BEGIN
    CREATE TABLE #hid (id INT, tidy NVARCHAR(200));
    INSERT #hid (id, tidy)
    SELECT h.id, x.tidy
    FROM weldoc_dropdown_hidden h
    CROSS APPLY (SELECT LTRIM(RTRIM(h.value)) AS t) a
    CROSS APPLY (
        SELECT TOP 1 n.norm + N' ' + LTRIM(SUBSTRING(a.t, LEN(n.norm) + 1, 200)) AS tidy
        FROM #norm n
        WHERE UPPER(LEFT(a.t, LEN(n.norm))) = n.norm AND SUBSTRING(a.t, LEN(n.norm) + 1, 1) LIKE N'[0-9 ]'
        ORDER BY LEN(n.norm) DESC) x
    WHERE h.type = 'dien_no' AND x.tidy <> h.value COLLATE Latin1_General_CS_AS;
    DELETE t FROM #hid t
    WHERE EXISTS (SELECT 1 FROM weldoc_dropdown_hidden h2 WHERE h2.type = 'dien_no' AND h2.value = t.tidy AND h2.id <> t.id);
    UPDATE h SET value = t.tidy FROM weldoc_dropdown_hidden h JOIN #hid t ON t.id = h.id;
    DROP TABLE #hid;
END

-- 6. Report
SELECT id AS global_material_id, raw AS dien_no_before, tidy AS dien_no_after
FROM #dien WHERE tidy <> raw COLLATE Latin1_General_CS_AS
ORDER BY raw, id;

-- Active catalogue entries that are now identical (reported only). Rows with the same
-- same_as value describe the same material; same_as is the oldest of them.
SELECT same_as, id, category, item_description, dien_no
FROM (
    SELECT g.id, g.category, g.item_description, g.dien_no,
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

DROP TABLE #norm;
DROP TABLE #dien;
