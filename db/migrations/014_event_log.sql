-- 014_event_log.sql
--
-- WHAT IT DOES
--   Creates weldoc_event_log: the event log (audit trail) of WeldDoc. Every change the app
--   makes to its data is written here - who, when, what, the old and the new values - and
--   actions that are not data changes (login, document export, ...).
--     occurred_at   DATETIME2   when (UTC, set by the database)
--     user_email    who: the login (unique, never reused) - 'system' for background work
--     user_name     who: the name shown
--     request_id    one user action = one id; its side effects (e.g. renumbered welds) share it
--     entity_type   e.g. weld, pipeline_material, project_material, global_material, ...
--     entity_id     the row it is about (NULL for actions like login)
--     pipeline_id, project_id   for filtering, where known
--     action        create / update / archive / strike / restore / delete / login / export ...
--     changes       JSON: {"field": ["old", "new"], ...}
--     reason        the reason given (e.g. the archive reason), if any
--
--   The log can only grow: a trigger refuses every UPDATE and DELETE on it, so no part of the
--   app - and no bug - can rewrite history.
--
-- REQUIRES
--   Nothing. Run it BEFORE the app version that writes the log is deployed: that version
--   refuses to save anything it cannot log.
--
-- DATA
--   A new, empty table. Nothing else changes. Running it again changes nothing.

SET XACT_ABORT ON;
SET NOCOUNT ON;

IF OBJECT_ID('weldoc_event_log', 'U') IS NULL
BEGIN
    CREATE TABLE weldoc_event_log (
        id           BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_weldoc_event_log PRIMARY KEY,
        occurred_at  DATETIME2(3)   NOT NULL CONSTRAINT DF_weldoc_event_log_at DEFAULT SYSUTCDATETIME(),
        user_email   NVARCHAR(255)  NOT NULL,
        user_name    NVARCHAR(255)  NULL,
        request_id   VARCHAR(36)    NULL,
        entity_type  VARCHAR(50)    NOT NULL,
        entity_id    BIGINT         NULL,
        pipeline_id  INT            NULL,
        project_id   INT            NULL,
        action       VARCHAR(30)    NOT NULL,
        changes      NVARCHAR(MAX)  NULL,
        reason       NVARCHAR(1000) NULL
    );
    CREATE NONCLUSTERED INDEX IX_weldoc_event_log_at ON weldoc_event_log (occurred_at);
    CREATE NONCLUSTERED INDEX IX_weldoc_event_log_entity ON weldoc_event_log (entity_type, entity_id);
    CREATE NONCLUSTERED INDEX IX_weldoc_event_log_pipeline ON weldoc_event_log (pipeline_id);
    CREATE NONCLUSTERED INDEX IX_weldoc_event_log_project ON weldoc_event_log (project_id);
END
GO

-- Append-only: no update, no delete - not even from the app
IF OBJECT_ID('TR_weldoc_event_log_append_only', 'TR') IS NULL
    EXEC('CREATE TRIGGER TR_weldoc_event_log_append_only ON weldoc_event_log
          INSTEAD OF UPDATE, DELETE
          AS
          BEGIN
              THROW 51401, ''weldoc_event_log is append-only: entries cannot be changed or deleted.'', 1;
          END');
GO

SELECT COUNT(*) AS event_log_entries,
       (SELECT COUNT(*) FROM sys.triggers WHERE name = 'TR_weldoc_event_log_append_only') AS append_only_trigger
FROM weldoc_event_log;
