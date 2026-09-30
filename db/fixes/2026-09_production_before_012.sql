-- 2026-09_production_before_012.sql      ONE-OFF DATA CORRECTION FOR PRODUCTION
--
-- Not a migration: it corrects the production rows that migration 012 cannot convert on its
-- own (found by its dry run on production, 2026-09-30). Run it once on production before
-- 012. Local does not need it (its test certificates were set to 3.1 by hand).
--
-- WHAT IT CHANGES
--   The certificate of three project materials that is not a certificate number becomes empty
--   (decided 2026-09-30):
--     project material  1  (project 9260144, Blind Flange)  "1425"  -> empty
--     project material 11  (project 9260144, Elbow)         "45"    -> empty
--     project material 12  (project "sdf",   Blind Flange)  "dsf"   -> empty
--   Only when the row still holds exactly that value; otherwise the script STOPS.
--
-- WHAT IT DOES NOT CHANGE
--   No row is deleted; nothing else on these rows changes. An empty certificate means the row
--   has no WAZ number until a certificate is entered (as for any material without one).
--
-- Dry run (always rolled back):
--   weldoc\venv\Scripts\python db\run_check.py db\fixes\2026-09_production_before_012.sql --env .env.prod

SET XACT_ABORT ON;
SET NOCOUNT ON;

SELECT id, certificate AS certificate_before, heat_no, project_id
FROM weldoc_project_materials WHERE id IN (1, 11, 12) ORDER BY id;

IF (SELECT COUNT(*) FROM weldoc_project_materials
    WHERE (id = 1 AND certificate = N'1425') OR (id = 11 AND certificate = N'45') OR (id = 12 AND certificate = N'dsf')) <> 3
    THROW 51301, N'fix stopped, nothing changed: the three certificates are not what the dry run found.', 1;

UPDATE weldoc_project_materials SET certificate = NULL
WHERE (id = 1 AND certificate = N'1425') OR (id = 11 AND certificate = N'45') OR (id = 12 AND certificate = N'dsf');

SELECT id, certificate AS certificate_after FROM weldoc_project_materials WHERE id IN (1, 11, 12) ORDER BY id;
