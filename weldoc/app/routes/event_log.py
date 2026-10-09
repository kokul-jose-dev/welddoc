"""Reading the event log (app/event_log.py) - for everyone who is logged in.

GET /api/event-log           entries, newest first; filters below; paged (limit / offset)
GET /api/event-log/export    the same filter as an Excel file
Filters: entityType, entityId, pipelineId, projectId, user, action, from, to (YYYY-MM-DD), q
"""

import datetime
import io
import json

from flask import Blueprint, jsonify, request, send_file
from sqlalchemy import and_, func, or_, select

from app.database import db
from app.event_log import event_log, can_read_log

event_log_bp = Blueprint("event_log", __name__)


def _forbidden():
    return jsonify({"error": "forbidden", "message": "Please sign in to see the event log."}), 403


def _filtered_query():
    t = event_log.c
    conds = []
    a = request.args
    if a.get("entityType"):
        conds.append(t.entity_type == a["entityType"])
    if a.get("entityTypes"):
        conds.append(t.entity_type.in_([x for x in a["entityTypes"].split(",") if x]))
    if a.get("actions"):
        conds.append(t.action.in_([x for x in a["actions"].split(",") if x]))
    if a.get("entityId", "").isdigit():
        conds.append(t.entity_id == int(a["entityId"]))
    if a.get("pipelineId", "").isdigit():
        conds.append(t.pipeline_id == int(a["pipelineId"]))
    if a.get("projectId", "").isdigit():
        pid = int(a["projectId"])
        pipeline_ids = [r.id for r in db.session.execute(
            db.text("SELECT id FROM weldoc_pipelines WHERE project_id = :p"), {"p": pid}).fetchall()]
        conds.append(or_(t.project_id == pid, t.pipeline_id.in_(pipeline_ids)) if pipeline_ids else t.project_id == pid)
    if a.get("user"):
        like = f"%{a['user'].strip().lower()}%"
        conds.append(or_(func.lower(t.user_email).like(like), func.lower(t.user_name).like(like)))
    if a.get("action"):
        conds.append(t.action == a["action"])
    for key, op in (("from", "ge"), ("to", "lt")):
        try:
            d = datetime.date.fromisoformat(a.get(key, ""))
        except ValueError:
            continue
        if op == "ge":
            conds.append(t.occurred_at >= datetime.datetime.combine(d, datetime.time.min))
        else:
            conds.append(t.occurred_at < datetime.datetime.combine(d + datetime.timedelta(days=1), datetime.time.min))
    if a.get("q"):
        like = f"%{a['q'].strip()}%"
        conds.append(or_(t.changes.like(like), t.reason.like(like), t.user_email.like(like), t.user_name.like(like),
                         t.entity_type.like(like)))
    return and_(*conds) if conds else None


# Fields in "changes" that hold the id of another row -> the type of that row, so the page can
# show "Hans (098)" instead of "welder_id 1".
REF_FIELDS = {
    "welder_id": "welder", "inspector_id": "welder",
    "material_a_id": "pipeline_material", "material_b_id": "pipeline_material", "connections": "pipeline_material",
    "project_material_id": "project_material", "global_material_id": "global_material",
    "pipeline_id": "pipeline", "project_id": "project", "client_id": "client",
}


def _ref_ids(value):
    vals = value if isinstance(value, list) else [value]
    return [int(v) for v in vals if isinstance(v, int) or (isinstance(v, str) and v.isdigit())]


def _labels(rows):
    """Readable names for what the entries are about: weld number, material letter, ..."""
    want = {}
    for r in rows:
        if r.entity_id is not None:
            want.setdefault(r.entity_type, set()).add(int(r.entity_id))
        if r.pipeline_id:
            want.setdefault("pipeline", set()).add(int(r.pipeline_id))
        try:
            changes = json.loads(r.changes) if r.changes else {}
        except ValueError:
            changes = {}
        for field, pair in changes.items():
            typ = REF_FIELDS.get(field)
            if typ and isinstance(pair, list):
                for v in pair:
                    want.setdefault(typ, set()).update(_ref_ids(v))
    sql = {      # (query, how the label is written)
        "weld": ("SELECT id, weld_no AS v FROM weldoc_welds WHERE id IN ({ids})", "weld {}"),
        "pipeline_material": ("SELECT id, position AS v FROM weldoc_pipeline_materials WHERE id IN ({ids})", "material {}"),
        "pipeline": ("SELECT id, no AS v FROM weldoc_pipelines WHERE id IN ({ids})", "{}"),
        "project": ("SELECT id, title AS v FROM weldoc_projects WHERE id IN ({ids})", "{}"),
        "client": ("SELECT id, name AS v FROM weldoc_clients WHERE id IN ({ids})", "{}"),
        "global_material": ("SELECT id, item_description AS v FROM weldoc_global_materials WHERE id IN ({ids})", "{}"),
        "project_material": ("SELECT id, heat_no AS v FROM weldoc_project_materials WHERE id IN ({ids})", "heat {}"),
        "welder": ("SELECT id, name AS v, no AS n FROM weldoc_welders WHERE id IN ({ids})", "{}"),
    }
    out = {}
    for typ, ids in want.items():
        if typ in sql and ids:
            query, fmt = sql[typ]
            id_csv = ",".join(str(i) for i in sorted(ids))
            try:
                for r in db.session.execute(db.text(query.format(ids=id_csv))).fetchall():
                    label = fmt.format(r.v if r.v not in (None, "") else "-")
                    extra = getattr(r, "n", None) if "n" in r._fields else None
                    out[(typ, int(r.id))] = f"{label} ({extra})" if extra else label
            except Exception:
                db.session.rollback()
    return out


def _display(field, value, labels):
    """A changed value as people read it: ids of other rows become their names."""
    typ = REF_FIELDS.get(field)
    if not typ or value is None:
        return value
    if isinstance(value, list):
        return [labels.get((typ, i), f"#{i}") for i in _ref_ids(value)]
    ids = _ref_ids(value)
    return labels.get((typ, ids[0]), f"#{ids[0]}") if ids else value


def _serialize(r, labels):
    try:
        changes = json.loads(r.changes) if r.changes else {}
    except ValueError:
        changes = {"raw": [None, r.changes]}
    shown = {f: [_display(f, p[0], labels), _display(f, p[1], labels)] if isinstance(p, list) and len(p) == 2 else p
             for f, p in changes.items()}
    return {
        "id": r.id,
        "at": r.occurred_at.isoformat() if hasattr(r.occurred_at, "isoformat") else r.occurred_at,
        "userEmail": r.user_email, "userName": r.user_name or "",
        "requestId": r.request_id,
        "entityType": r.entity_type, "entityId": r.entity_id,
        "entityLabel": labels.get((r.entity_type, int(r.entity_id))) if r.entity_id is not None else None,
        "pipelineId": r.pipeline_id, "pipelineNo": labels.get(("pipeline", int(r.pipeline_id))) if r.pipeline_id else None,
        "projectId": r.project_id,
        "action": r.action, "changes": changes, "shown": shown, "reason": r.reason or "",
    }


@event_log_bp.route("", methods=["GET"])
def list_events():
    if not can_read_log():
        return _forbidden()
    where = _filtered_query()
    limit = min(max(request.args.get("limit", 200, type=int), 1), 1000)
    offset = max(request.args.get("offset", 0, type=int), 0)
    t = event_log.c
    q = select(event_log)
    cq = select(func.count()).select_from(event_log)
    if where is not None:
        q, cq = q.where(where), cq.where(where)
    rows = db.session.execute(q.order_by(t.id.desc()).limit(limit).offset(offset)).fetchall()
    total = db.session.execute(cq).scalar()
    labels = _labels(rows)
    return jsonify({"total": total, "entries": [_serialize(r, labels) for r in rows]})


@event_log_bp.route("/export", methods=["GET"])
def export_events():
    if not can_read_log():
        return _forbidden()
    from openpyxl import Workbook
    from openpyxl.styles import Font

    where = _filtered_query()
    q = select(event_log)
    if where is not None:
        q = q.where(where)
    rows = db.session.execute(q.order_by(event_log.c.id.asc()).limit(50000)).fetchall()
    labels = _labels(rows)
    wb = Workbook()
    ws = wb.active
    ws.title = "Event log"
    import re
    from app.dates import fmt_date, fmt_datetime

    def _val(v):
        # a changed date field (stored "2026-09-19") reads like every other date in the documents
        if v is None:
            return ""
        s = str(v)
        return fmt_date(s) if re.fullmatch(r"\d{4}-\d{2}-\d{2}", s) else s

    head = ["#", "When (UTC)", "User", "Login", "Action", "What", "Pipeline", "Field", "Old value", "New value", "Reason", "Request"]
    ws.append(head)
    for c in ws[1]:
        c.font = Font(bold=True)
    for r in rows:
        e = _serialize(r, labels)
        what = f"{e['entityType']} {e['entityLabel'] or e['entityId'] or ''}".strip()
        base = [e["id"], fmt_datetime(e["at"]), e["userName"], e["userEmail"], e["action"], what,
                e["pipelineNo"] or ""]
        items = list(e["changes"].items()) or [("", [None, None])]
        for field, pair in items:
            old, new = (pair + [None, None])[:2] if isinstance(pair, list) else (None, pair)
            ws.append(base + [field, _val(old), _val(new), e["reason"], e["requestId"] or ""])
    for col, w in zip("ABCDEFGHIJKL", (8, 20, 22, 30, 10, 26, 22, 20, 30, 30, 30, 38)):
        ws.column_dimensions[col].width = w
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    name = f"weldoc_event_log_{datetime.date.today().isoformat()}.xlsx"
    return send_file(buf, as_attachment=True, download_name=name,
                     mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
