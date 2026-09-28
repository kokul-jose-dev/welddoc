"""Turn a save the database refused into a message a user can act on.

Since db/migrations 001-005 the database itself refuses wrong data (a welder that does not
exist, a visual result that is not OK / Not OK / n/a, an order number that is too long,
...). Without this, such a refusal reaches the user as "INTERNAL SERVER ERROR". Here the
database's own message is recognised and replaced by a plain one; anything not recognised
is left alone and stays a normal server error.

Returns (http_status, code, message):
    400 - the value itself is not allowed (fix the input)
    409 - it conflicts with other data (reload, or it is still in use)
"""

import re

from sqlalchemy.exc import DataError, IntegrityError, ProgrammingError

# Rules added by db/migrations, by name.
NAMED_RULES = {
    "CK_weldoc_welds_visual": (400, "The visual result is not allowed. Choose OK, Not OK or n/a."),
    "CK_weldoc_welds_endoscopy": (400, "The endoscopy result is not allowed. Choose OK, Not OK or n/a."),
    "CK_weldoc_welds_type": (400, "The weld type is not allowed. Choose O-V, O-M, H-V or H-M."),
    "CK_weldoc_pipelines_status": (400, "The pipeline step is not valid (allowed are steps 0 to 5)."),
    "FK_weldoc_welds_welder": (409, "The selected welder does not exist (any more). Reload the page and choose the welder again."),
    "FK_weldoc_welds_inspector": (409, "The selected inspector does not exist (any more). Reload the page and choose the inspector again."),
}

TABLE_LABELS = {
    "weldoc_clients": "client",
    "weldoc_projects": "project",
    "weldoc_pipelines": "pipeline",
    "weldoc_global_materials": "material",
    "weldoc_project_materials": "project material",
    "weldoc_pipeline_materials": "pipeline material",
    "weldoc_pipeline_material_connections": "connection",
    "weldoc_welds": "weld",
    "weldoc_welders": "welder",
    "weldoc_weldercertificate": "welder certificate",
    "weldoc_wps_processes": "WPS process",
    "weldoc_users": "user",
}

COLUMN_LABELS = {
    "order_no": "order number",
    "ist_project_no": "IST project number",
    "no": "number",
    "name": "name",
    "title": "title",
    "cert_no": "certificate number",
    "heat_no": "heat number",
    "certificate": "certificate",
    "weld_no": "weld number",
    "welder_id": "welder",
    "inspector_id": "inspector",
    "project_id": "project",
    "pipeline_id": "pipeline",
    "global_material_id": "material",
    "project_material_id": "project material",
    "client_id": "client",
    "position": "position",
    "item_description": "item description",
    "category": "category",
}


def _label(mapping, name, fallback):
    return mapping.get((name or "").lower(), (name or fallback).replace("_", " "))


def _table_of(text):
    # SQL Server: table "dbo.weldoc_welds" / object 'dbo.weldoc_welds' / table 'db.dbo.weldoc_welds'
    m = re.search(r"(?i)(?:table|object)\s+['\"](?:[\w]+\.)*(weldoc_\w+)['\"]", text)
    if m:
        return m.group(1)
    m = re.search(r"(?i)\b(weldoc_\w+)\.\w+", text)      # SQLite: weldoc_welds.visual
    return m.group(1) if m else ""


def _column_of(text):
    m = re.search(r"(?i)column\s+'(\w+)'", text)          # SQL Server
    if m:
        return m.group(1)
    m = re.search(r"(?i)\bweldoc_\w+\.(\w+)", text)       # SQLite
    return m.group(1) if m else ""


def friendly_db_error(exc):
    """(status, code, message) for a recognised refusal, otherwise None."""
    # The ODBC driver files "too long" (22001) under ProgrammingError rather than DataError,
    # so that category is looked at too - only the patterns below are recognised in it.
    if not isinstance(exc, (IntegrityError, DataError, ProgrammingError)):
        return None
    text = str(getattr(exc, "orig", exc) or "")

    # 1. A rule we added ourselves, recognised by its name.
    for name, (status, message) in NAMED_RULES.items():
        if name.lower() in text.lower():
            return status, "not_allowed" if status == 400 else "conflict", message

    table = _table_of(text)
    column = _column_of(text)
    thing = _label(TABLE_LABELS, table, "record")
    field = _label(COLUMN_LABELS, column, "a field")

    # 2. Deleting something that other data still points to. The table named in the
    #    database message is the one that still points to it.
    if re.search(r"(?i)REFERENCE constraint", text):
        return 409, "in_use", f"This cannot be deleted: it is still used by a {thing}."

    # 3. Pointing to something that does not exist (any more). The table named in the
    #    database message is the one pointed to.
    if re.search(r"(?i)FOREIGN KEY constraint", text):
        return 409, "conflict", (f"The selected {thing} does not exist (any more). "
                                 "Reload the page and try again.")

    # 4. A required field left empty.
    if re.search(r"(?i)Cannot insert the value NULL|NOT NULL constraint failed", text):
        return 400, "required", f"The field '{field}' of the {thing} must be filled in."

    # 5. Something that already exists (unique rules - the no-duplicate rules come later).
    if re.search(r"(?i)duplicate key|UNIQUE (KEY )?constraint", text):
        return 409, "duplicate", f"This {thing} already exists. Reload the page to see it."

    # 6. Text longer than the column allows.
    if re.search(r"(?i)would be truncated", text):
        return 400, "too_long", f"The {field} is too long."

    # 7. A value that cannot become the column's type (number, date).
    if re.search(r"(?i)Error converting data type|Conversion failed|Arithmetic overflow", text):
        return 400, "not_allowed", "A value could not be saved as a number or date. Please check what was entered."

    # 8. Any other rule.
    if re.search(r"(?i)CHECK constraint", text):
        return 400, "not_allowed", f"A value of the {thing} is not allowed."

    return None
