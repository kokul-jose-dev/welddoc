-- 000_schema_version.sql
-- Creates the table that records which migration files have been applied to THIS
-- database. It changes nothing else and touches no existing data.
--
-- run_migrations.py writes one row here for every file it applies (including this one),
-- in the same transaction as the file itself.

IF OBJECT_ID('weldoc_schema_version', 'U') IS NULL
BEGIN
    CREATE TABLE weldoc_schema_version (
        version     CHAR(3)        NOT NULL PRIMARY KEY,   -- '000', '001', ...
        name        NVARCHAR(200)  NOT NULL,               -- file name, e.g. 001_flags_not_null.sql
        checksum    CHAR(64)       NOT NULL,               -- SHA-256 of the file when it ran
        applied_at  DATETIME2(0)   NOT NULL CONSTRAINT DF_weldoc_schema_version_applied_at DEFAULT SYSUTCDATETIME(),
        applied_by  NVARCHAR(100)  NOT NULL
    );
END
