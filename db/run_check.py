"""Run a read-only check script and print every result it returns.

    weldoc\\venv\\Scripts\\python db\\run_check.py db\\checks\\01_schema_overview.sql
    weldoc\\venv\\Scripts\\python db\\run_check.py db\\checks\\02_health_check.sql --env .env.prod

Safe by construction: the whole script runs inside a transaction that is ALWAYS rolled
back at the end, so even if a check file contained a write by mistake, nothing would be
kept. Temporary #tables the checks create disappear with the connection.
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _db import load_connection_string, describe_target, connect, split_batches, read_sql_file  # noqa: E402


def print_result(cursor, max_rows):
    cols = [d[0] for d in cursor.description]
    rows = cursor.fetchall()
    if not rows:
        print("  (no rows)\n")
        return
    shown = rows[:max_rows]
    widths = [min(40, max(len(str(c)), *(len(_fmt(r[i])) for r in shown))) for i, c in enumerate(cols)]
    line = "  " + " | ".join(str(c).ljust(w)[:w] for c, w in zip(cols, widths))
    print(line)
    print("  " + "-+-".join("-" * w for w in widths))
    for r in shown:
        print("  " + " | ".join(_fmt(v).ljust(w)[:w] for v, w in zip(r, widths)))
    if len(rows) > max_rows:
        print(f"  ... {len(rows) - max_rows} more row(s) not shown (use --max-rows)")
    print(f"  ({len(rows)} row(s))\n")


def _fmt(v):
    return "NULL" if v is None else str(v)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file", help="check script to run (.sql)")
    ap.add_argument("--env", help="env file with AZURE_SQL_CONNECTION_STRING (default: repo .env)")
    ap.add_argument("--max-rows", type=int, default=200, help="rows to print per result (default 200)")
    args = ap.parse_args()

    conn_str = load_connection_string(args.env)
    server, database = describe_target(conn_str)
    print(f"Target : {server} / {database}")
    print(f"Script : {args.file}")
    print("Mode   : READ-ONLY (rolled back at the end)\n")

    conn = connect(conn_str)
    cur = conn.cursor()
    n = 0
    try:
        for batch in split_batches(read_sql_file(args.file)):
            cur.execute(batch)
            while True:
                if cur.description:           # this statement returned rows
                    n += 1
                    print(f"--- Result {n} ---")
                    print_result(cur, args.max_rows)
                if not cur.nextset():
                    break
    finally:
        conn.rollback()
        conn.close()
    print("Done. Rolled back - nothing was changed.")


if __name__ == "__main__":
    main()
