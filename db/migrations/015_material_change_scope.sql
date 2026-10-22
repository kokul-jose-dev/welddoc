-- 015_material_change_scope.sql
--
-- Changing a material from a pipe: A (only this material), B (whole pipe), C (everywhere).
-- A change made everywhere leaves pipes on final and locked positions on the old material;
-- the old material remembers what replaced it, so such a pipe can be asked later whether to
-- apply the change too. See weldoc/app/material_change.py.
--
-- WHAT IT DOES
--   1. weldoc_project_materials gets:
--        replaced_by_id   INT             the project material that replaced this one (NULL = not replaced)
--        replaced_at      DATETIME2       when
--        replaced_by      NVARCHAR(255)   who (the signed-in user)
--        replace_note     NVARCHAR(500)   old -> new, for the question in the pipe
--   2. weldoc_global_materials gets:
--        replaced_by_id   INT             the corrected specification (the old one is archived)
--   3. New table weldoc_material_change_answers: what a pipe on final answered
--        (apply / keep, who, when) - "keep" is not asked again for the same newer material.
--
-- REQUIRES
--   Nothing. The app also adds these at startup (app/__init__.py); running this first is fine.
--
-- DATA
--   No row is deleted, no existing value is changed. Running it again changes nothing.
--
-- Only weldoc_project_materials, weldoc_global_materials and the new weldoc_material_change_answers.

SET XACT_ABORT ON;
SET NOCOUNT ON;

IF COL_LENGTH('weldoc_project_materials', 'replaced_by_id') IS NULL
    ALTER TABLE weldoc_project_materials ADD replaced_by_id INT NULL;
IF COL_LENGTH('weldoc_project_materials', 'replaced_at') IS NULL
    ALTER TABLE weldoc_project_materials ADD replaced_at DATETIME2 NULL;
IF COL_LENGTH('weldoc_project_materials', 'replaced_by') IS NULL
    ALTER TABLE weldoc_project_materials ADD replaced_by NVARCHAR(255) NULL;
IF COL_LENGTH('weldoc_project_materials', 'replace_note') IS NULL
    ALTER TABLE weldoc_project_materials ADD replace_note NVARCHAR(500) NULL;
IF COL_LENGTH('weldoc_global_materials', 'replaced_by_id') IS NULL
    ALTER TABLE weldoc_global_materials ADD replaced_by_id INT NULL;

IF OBJECT_ID('weldoc_material_change_answers', 'U') IS NULL
BEGIN
    CREATE TABLE weldoc_material_change_answers (
        id                  INT IDENTITY(1,1) PRIMARY KEY,
        pipeline_id         INT NOT NULL REFERENCES weldoc_pipelines(id),
        project_material_id INT NOT NULL REFERENCES weldoc_project_materials(id),
        replacement_id      INT NOT NULL REFERENCES weldoc_project_materials(id),
        answer              NVARCHAR(10) NOT NULL,
        answered_by         NVARCHAR(255) NULL,
        answered_at         DATETIME2 NULL
    );
    CREATE INDEX ix_weldoc_material_change_answers_pipeline_id ON weldoc_material_change_answers (pipeline_id);
END;

SELECT 'done' AS [status],
       COL_LENGTH('weldoc_project_materials', 'replaced_by_id') AS pm_replaced_by_id,
       COL_LENGTH('weldoc_global_materials', 'replaced_by_id') AS gm_replaced_by_id,
       OBJECT_ID('weldoc_material_change_answers', 'U') AS answers_table;
