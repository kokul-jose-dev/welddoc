"""The event log (audit trail): who changed what, when, from which value to which.

Every insert, update and delete the app makes through the ORM is written to weldoc_event_log
automatically, in the same transaction as the change itself (after_flush): if the entry cannot
be written, the change is not saved either. Nothing in a route has to remember to log.

Writes that bypass the ORM (raw SQL, bulk updates) and actions that are not data changes
(login, document export) call log_event() themselves.

The table only grows - migration 014 puts a trigger on it that refuses UPDATE and DELETE.
Everyone who is logged in can read it (routes/event_log.py).
"""

import datetime
import decimal
import json
import re
import uuid

from flask import current_app, g, has_request_context, session
from sqlalchemy import (BigInteger, Column, DateTime, Integer, MetaData, String, Table, Unicode,
                        UnicodeText, event, inspect, text)
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import get_history

from app.database import db

_meta = MetaData()
event_log = Table(
    "weldoc_event_log", _meta,
    Column("id", BigInteger().with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True),
    Column("occurred_at", DateTime, server_default=text("CURRENT_TIMESTAMP")),
    Column("user_email", Unicode(255), nullable=False),
    Column("user_name", Unicode(255)),
    Column("request_id", String(36)),
    Column("entity_type", String(50), nullable=False),
    Column("entity_id", BigInteger().with_variant(Integer, "sqlite")),
    Column("pipeline_id", Integer),
    Column("project_id", Integer),
    Column("action", String(30), nullable=False),
    Column("changes", UnicodeText),
    Column("reason", Unicode(1000)),
)


# --- who / which request ------------------------------------------------------------------------

def current_actor():
    """(email, name) of the signed-in user; ('system', ...) outside a request (background work)."""
    if has_request_context():
        user = session.get("user") or {}
        email = (user.get("email") or "").strip()
        if email:
            return email[:255], (user.get("name") or "")[:255] or None
    return "system", "WeldDoc (background)"


def _request_id():
    if not has_request_context():
        return None
    if not getattr(g, "event_request_id", None):
        g.event_request_id = str(uuid.uuid4())
    return g.event_request_id


# --- values -------------------------------------------------------------------------------------

def _plain(value):
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, (datetime.datetime, datetime.date)):
        return value.isoformat()
    if isinstance(value, decimal.Decimal):
        return format(value, "f")
    if isinstance(value, (bytes, bytearray)):
        return f"<{len(value)} bytes>"
    return str(value)


def _entity_type(obj):
    return re.sub(r"(?<!^)(?=[A-Z])", "_", type(obj).__name__).lower()


def _where(obj):
    """(pipeline_id, project_id) the entry belongs to, where the object knows it."""
    name = _entity_type(obj)
    pipeline_id = obj.id if name == "pipeline" else getattr(obj, "pipeline_id", None)
    project_id = obj.id if name == "project" else getattr(obj, "project_id", None)
    return pipeline_id, project_id


def _pk(obj):
    try:
        ident = inspect(obj).identity
        return ident[0] if ident else getattr(obj, "id", None)
    except Exception:
        return getattr(obj, "id", None)


# --- automatic capture ------------------------------------------------------------------------

def _m2m_props(mapper):
    return [r for r in mapper.relationships if r.secondary is not None]


def _ids(objs):
    return sorted(_pk(o) for o in objs if o is not None and _pk(o) is not None)


def _changes(obj, created=False):
    mapper = inspect(obj).mapper
    out = {}
    for attr in mapper.column_attrs:
        key = attr.key
        hist = get_history(obj, key)
        if created:
            if hist.added and hist.added[0] is not None:
                out[key] = [None, _plain(hist.added[0])]
            continue
        if hist.has_changes():
            old = hist.deleted[0] if hist.deleted else None
            new = hist.added[0] if hist.added else None
            if _plain(old) != _plain(new):
                out[key] = [_plain(old), _plain(new)]
    for rel in _m2m_props(mapper):
        hist = get_history(obj, rel.key)
        if hist.added or hist.deleted:
            old = _ids(list(hist.unchanged) + list(hist.deleted))
            new = _ids(list(hist.unchanged) + list(hist.added))
            if old != new:
                out[rel.key] = [old, new]
    return out


def _snapshot(obj):
    """What a deleted row held (the values still in memory - nothing is loaded for it)."""
    out = {}
    state = inspect(obj)
    for attr in state.mapper.column_attrs:
        value = state.dict.get(attr.key)
        if value is not None:
            out[attr.key] = [_plain(value), None]
    return out


def _action(obj, changes, created=False, deleted=False):
    if created:
        return "create"
    if deleted:
        return "delete"
    if "archived" in changes:
        if changes["archived"][1]:
            return "strike" if getattr(obj, "struck", False) else "archive"
        return "restore"
    return "update"


def _row(obj, action, changes):
    pipeline_id, project_id = _where(obj)
    email, name = current_actor()
    reason = None
    if action in ("archive", "strike"):
        reason = getattr(obj, "archive_reason", None)
    return {
        "user_email": email, "user_name": name, "request_id": _request_id(),
        "entity_type": _entity_type(obj), "entity_id": _pk(obj),
        "pipeline_id": pipeline_id, "project_id": project_id,
        "action": action, "changes": json.dumps(changes, ensure_ascii=False, default=str) if changes else None,
        "reason": (reason or None) and str(reason)[:1000],
    }


def _after_flush(sess, flush_context):
    rows = []
    for obj in sess.new:
        rows.append(_row(obj, "create", _changes(obj, created=True)))
    for obj in sess.dirty:
        if not sess.is_modified(obj, include_collections=True):
            continue
        changes = _changes(obj)
        if changes:
            rows.append(_row(obj, _action(obj, changes), changes))
    for obj in sess.deleted:
        rows.append(_row(obj, "delete", _snapshot(obj)))
    if rows:
        _insert_rows(sess.connection(), rows)


def _insert_rows(conn, rows):
    """All entries in ONE multi-row INSERT (per 150 rows - SQL Server takes at most 2100
    parameters per statement). A list passed to execute() would be sent row by row, and on a
    remote database every statement is a round trip."""
    for i in range(0, len(rows), 150):
        conn.execute(event_log.insert().values(rows[i:i + 150]))


def _keep_old_values():
    """Make the ORM load a column's old value before it is overwritten, even when it was not
    loaded yet - otherwise the log could only say "changed to X" without "from Y"."""
    for mapper in db.Model.registry.mappers:
        for attr in mapper.column_attrs:
            impl = mapper.class_manager[attr.key].impl
            impl.active_history = True


_installed = False


def init_event_log(app):
    global _installed
    with app.app_context():
        if db.engine.dialect.name == "sqlite":          # tests / local file database
            _meta.create_all(db.engine)
    if _installed:
        return
    _keep_old_values()
    event.listen(Session, "after_flush", _after_flush)
    _installed = True


# --- explicit entries ------------------------------------------------------------------------------

def log_event(entity_type, entity_id, action, changes=None, reason=None, pipeline_id=None, project_id=None):
    """An entry for something the automatic capture cannot see (raw SQL, login, export, ...).
    Written in the current transaction - committed with the change it describes."""
    log_events([dict(entity_type=entity_type, entity_id=entity_id, action=action, changes=changes,
                     reason=reason, pipeline_id=pipeline_id, project_id=project_id)])


def log_events(entries):
    """Several log_event() entries in one statement."""
    if not entries:
        return
    email, name = current_actor()
    rid = _request_id()
    _insert_rows(db.session.connection(), [{
        "user_email": email, "user_name": name, "request_id": rid,
        "entity_type": e["entity_type"], "entity_id": e.get("entity_id"),
        "pipeline_id": e.get("pipeline_id"), "project_id": e.get("project_id"), "action": e["action"],
        "changes": json.dumps(e["changes"], ensure_ascii=False, default=str) if e.get("changes") else None,
        "reason": (e.get("reason") or None) and str(e["reason"])[:1000],
    } for e in entries])


def can_read_log():
    """Everyone who is logged in may read the log."""
    if not has_request_context():
        return False
    return bool(((session.get("user") or {}).get("email") or "").strip())
