# Database changes

Every change to the WeldDoc database structure is a numbered SQL file in `migrations/`.
The same file is run on the local database first, then on production — so both always
have exactly the same structure, and git shows what changed, when and why.

**No file here deletes data unless it says so at the top in capitals.** Most changes add
a column, protect a column, or add an index; every row stays where it is.

## Folder

```
db/
├── README.md               this file
├── _db.py                  shared helper: reads the connection string, connects
├── run_check.py            runs a check script READ-ONLY and prints the results
├── run_migrations.py       shows / applies the migration files a database has not had yet
├── checks/                 read-only scripts - look, never change
│   ├── 01_schema_overview.sql   the real structure: tables, columns, indexes, keys
│   └── 02_health_check.sql      data damage: broken welds, duplicates, NULL flags, ...
└── migrations/             the changes, applied in number order, each exactly once
    └── 000_schema_version.sql   creates the table that records what has been applied
```

## Which database does it use?

The same one the app on this machine uses: `AZURE_SQL_CONNECTION_STRING` from the `.env`
file in the repo root (your local RDS database). For production, put the production
connection string in a separate file, e.g. `.env.prod` (git ignores it), and add
`--env .env.prod`. Both tools print the target server and database before doing anything.

## Commands

Run from the repo root (`C:\Users\...\welddoc`):

```
# look (read-only - always rolled back)
weldoc\venv\Scripts\python db\run_check.py db\checks\01_schema_overview.sql
weldoc\venv\Scripts\python db\run_check.py db\checks\02_health_check.sql

# what has been applied, what is pending
weldoc\venv\Scripts\python db\run_migrations.py status

# apply pending files - asks you to type the database name first
weldoc\venv\Scripts\python db\run_migrations.py apply
```

## The routine for every change

1. Write the next file, e.g. `migrations/001_flags_not_null.sql`. One change per file.
   The top of the file says in plain words what it does and whether it touches data.
2. `status`, then `apply` on the **local** database. Test the app.
3. Production: rehearse on the **staging copy** of production first when the change
   touches data. Then `status --env .env.prod` and `apply --env .env.prod`.
4. Commit the file together with any code that needs it.

## Rules

- **Never edit a file that has already been applied** anywhere. Fix a mistake with a new
  file. The runner notices an edited file (by checksum) and refuses to continue.
- **Only `weldoc_*` tables.** The local database is shared with another application;
  nothing here may touch its tables.
- **Each file runs in one transaction** with its record in `weldoc_schema_version`: it is
  either fully applied and recorded, or not at all. The runner stops at the first failure.
- Files may use `GO` lines to separate batches, as in SSMS.
- `schema.sql` in the repo root is the old, out-of-date description; it is not used by
  this process.
