-- 013_project_material_global_waz_url.sql
--
-- WHAT IT DOES
--   weldoc_project_materials gets one column:
--     waz_global_url   NVARCHAR(500)   where this material's WAZ certificate is in the global
--                                      WAZ folder on SharePoint (NULL = not there / not known yet)
--   Next to waz_pdf_url, the copy in the project folder. Filled in by the app when a
--   certificate is uploaded, or the first time it is opened from the Materials pages; kept up
--   to date when a spec change renames it and cleared when it is removed (app/global_waz.py).
--
-- REQUIRES
--   Nothing. Run it BEFORE the app version that uses the column is deployed: the current app
--   does not know it and keeps working (the column is empty).
--
-- DATA
--   No row is deleted, no existing value changes. Running it again changes nothing.
--
-- Only weldoc_project_materials gets the column.

SET XACT_ABORT ON;
SET NOCOUNT ON;

IF COL_LENGTH('weldoc_project_materials', 'waz_global_url') IS NULL
    ALTER TABLE weldoc_project_materials ADD waz_global_url NVARCHAR(500) NULL;
GO

SELECT COUNT(*) AS project_materials,
       SUM(CASE WHEN waz_pdf_url IS NOT NULL AND waz_pdf_url <> '' THEN 1 ELSE 0 END) AS with_project_certificate,
       SUM(CASE WHEN waz_global_url IS NOT NULL THEN 1 ELSE 0 END) AS with_global_url
FROM weldoc_project_materials;
