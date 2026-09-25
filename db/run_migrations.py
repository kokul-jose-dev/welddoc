"""Apply the numbered SQL files in db/migrations/ that this database has not had yet.

    weldoc\\venv\\Scripts\\python db\\run_migrations.py status               # what has run, what is pending
    weldoc\\venv\\Scripts\\python db\\run_migrations.py apply                # run all pending, in order
    weldoc\\venv\\Scripts\\python db\\run_migrations.py apply --to 003       # run pending up to 003 only
    weldoc\\venv\\Scripts\\python db\\run_migrations.py status --env .env.prod

How it keeps track: weldoc_schema_version (created by 000_schema_version.sql) holds one
row per file that has run - its number, name, checksum, when and by whom. A file is
applied once per database; the same file is later run on production unchanged.

Safety:
  - `status` only reads.
  - `apply` shows the target server / database and the files it will run, then asks you
    to type the database name before touching anything.
  - Each file runs in ONE transaction together with its weldoc_schema_version row: either
    the whole file is applied and recorded, or nothing of it is.
  - It stops at the first failure; later files are not attempted.
  - An already-applied file whose content has changed since is reported. Applied files
    must never be edited - fix mistakes with a new file.
"""

import argparse
import getpass
import hashlib
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _db import load_connection_string, describe_target, connect, split_batches, read_sql_file  # noqa: E402
from run_check import print_result  # noqa: E402

MIGRATIONS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "migrations")
FILE_RE = re.compile(r"^(\d{3})_[a-z0-9_]+\.sql$")
VERSION_TABLE = "weldoc_schema_version"


def migration_files():
    out = []
    for name in sorted(os.listdir(MIGRATIONS_DIR)):
        if not name.endswith(".sql"):
            continue
        m = FILE_RE.match(name)
        if not m:
            sys.exit(f"Bad migration file name: {name} (expected NNN_lowercase_words.sql)")
        path = os.path.join(MIGRATIONS_DIR, name)
        sql = read_sql_file(path)
        out.append({"version": m.group(1), "name": name, "path": path, "sql": sql,
                    "checksum": hashlib.sha256(sql.encode("utf-8")).hexdigest()})
    versions = [f["version"] for f in out]
    dupes = {v for v in versions if versions.count(v) > 1}
    if dupes:
        sys.exit(f"Two migration files share the number(s): {', '.join(sorted(dupes))}")
    return out


def applied_versions(cur):
    cur.execute("SELECT OBJECT_ID(?, 'U')", VERSION_TABLE)
    if cur.fetchone()[0] is None:
        return {}   # nothing applied yet - not even 000
    cur.execute(f"SELECT version, name, checksum, applied_at, applied_by FROM {VERSION_TABLE} ORDER BY version")
    return {r.version: r for r in cur.fetchall()}


def show_status(files, applied):
    for f in files:
        a = applied.get(f["version"])
        if a:
            note = "" if a.checksum == f["checksum"] else "   !! FILE CHANGED SINCE IT WAS APPLIED"
            print(f"  [applied {a.applied_at:%Y-%m-%d %H:%M} by {a.applied_by}]  {f['name']}{note}")
        else:
            print(f"  [pending]                            {f['name']}")
    unknown = sorted(set(applied) - {f["version"] for f in files})
    for v in unknown:
        print(f"  [applied, but no file here]          {applied[v].name}   !! missing from db/migrations")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["status", "apply"])
    ap.add_argument("--env", help="env file with AZURE_SQL_CONNECTION_STRING (default: repo .env)")
    ap.add_argument("--to", help="apply pending files up to and including this number, e.g. 003")
    args = ap.parse_args()

    conn_str = load_connection_string(args.env)
    server, database = describe_target(conn_str)
    files = migration_files()

    conn = connect(conn_str)
    cur = conn.cursor()
    try:
        applied = applied_versions(cur)
        conn.rollback()

        print(f"Target : {server} / {database}\n")
        show_status(files, applied)
        pending = [f for f in files if f["version"] not in applied]
        if args.to:
            pending = [f for f in pending if f["version"] <= args.to]

        if args.command == "status":
            print(f"\n{len(pending)} pending.")
            return
        if not pending:
            print("\nNothing to apply.")
            return
        if any(a.checksum != f["checksum"] for f in files for a in [applied.get(f["version"])] if a):
            sys.exit("\nAn applied file has been edited since it ran. Restore it first; "
                     "put new changes in a new file.")

        print("\nWill apply, in this order:")
        for f in pending:
            print(f"  - {f['name']}")
        typed = input(f"\nType the database name ({database}) to continue, anything else to stop: ").strip()
        if typed != database:
            print("Stopped. Nothing was changed.")
            return

        who = f"{getpass.getuser()}@{os.environ.get('COMPUTERNAME', '')}".strip("@")
        for f in pending:
            print(f"\n>> {f['name']}")
            try:
                for batch in split_batches(f["sql"]):
                    cur.execute(batch)
                    while True:            # show any report the file returns; errors surface here
                        if cur.description:
                            print_result(cur, 200)
                        if not cur.nextset():
                            break
                cur.execute(
                    f"INSERT INTO {VERSION_TABLE} (version, name, checksum, applied_by) VALUES (?, ?, ?, ?)",
                    f["version"], f["name"], f["checksum"], who[:100])
                conn.commit()
                print("   applied and recorded.")
            except Exception as e:
                conn.rollback()
                print(f"   FAILED - rolled back, nothing from this file was kept.\n   {e}")
                sys.exit("Stopped at the first failure; later files were not attempted.")
        print("\nAll done.")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
