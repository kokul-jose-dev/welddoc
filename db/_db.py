"""Shared connection helper for run_check.py and run_migrations.py.

Reads the same connection string the app uses (AZURE_SQL_CONNECTION_STRING) from an
.env file, so these tools always talk to the database the app on this machine talks to.
Pass --env to point at another file, e.g. one holding the production connection string.
"""

import os
import re
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_ENV = os.path.join(REPO_ROOT, ".env")


def load_connection_string(env_file=None):
    from dotenv import dotenv_values

    path = env_file or DEFAULT_ENV
    if not os.path.isfile(path):
        sys.exit(f"Env file not found: {path}")
    conn = (dotenv_values(path).get("AZURE_SQL_CONNECTION_STRING") or "").strip()
    if not conn:
        sys.exit(f"AZURE_SQL_CONNECTION_STRING is not set in {path}")
    return conn


def describe_target(conn_str):
    """Server and database name only - never the user name or password."""
    def part(key):
        m = re.search(rf"(?i)\b{key}\s*=\s*([^;]*)", conn_str)
        return m.group(1).strip() if m else "?"
    return part("Server"), part("Database")


def connect(conn_str):
    import pyodbc
    # autocommit off: every file runs inside one transaction the caller commits or rolls back
    return pyodbc.connect(conn_str, autocommit=False)


def split_batches(sql):
    """Split a script on lines that contain only GO, as SSMS / sqlcmd do.

    GO is not T-SQL - it is a batch separator understood by the tools. Some statements
    (CREATE VIEW, CREATE PROCEDURE) must be the first in their batch, so files may use it.
    """
    batches, cur = [], []
    for line in sql.splitlines():
        if re.fullmatch(r"\s*GO\s*;?\s*", line, flags=re.IGNORECASE):
            if "".join(cur).strip():
                batches.append("\n".join(cur))
            cur = []
        else:
            cur.append(line)
    if "".join(cur).strip():
        batches.append("\n".join(cur))
    return batches


def read_sql_file(path):
    # utf-8-sig drops the BOM that SSMS / Notepad sometimes put at the start of a file
    with open(path, encoding="utf-8-sig") as f:
        return f.read()
