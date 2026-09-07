from flask import Blueprint, request, jsonify
from app.database import db
from app.models.wps_process import WpsProcess, seed_wps_processes

wps_processes_bp = Blueprint("wps_processes", __name__)


def _serialize(item):
    return {
        "id": item.id,
        "wpsNo": item.wps_no,
        "process": item.process,
        "archived": bool(item.archived),
    }


_wps_cache = {}


def invalidate_wps_cache():
    global _wps_cache
    _wps_cache.clear()


def ensure_wps_process(wps_no: str, process: str):
    """Ensure a WPS No. and process combination is stored in the database."""
    if not wps_no or not process:
        return None
    wps_clean = wps_no.strip()
    proc_clean = process.strip()
    if not wps_clean or not proc_clean:
        return None

    # Check cache first to avoid slow DB query
    cached_list = _wps_cache.get(False)
    if cached_list is not None:
        for item in cached_list:
            if item["wpsNo"].lower() == wps_clean.lower() and item["process"].lower() == proc_clean.lower():
                return item

    try:
        existing = WpsProcess.query.filter(
            db.func.lower(WpsProcess.wps_no) == wps_clean.lower(),
            db.func.lower(WpsProcess.process) == proc_clean.lower(),
        ).first()
        if not existing:
            item = WpsProcess(wps_no=wps_clean, process=proc_clean)
            db.session.add(item)
            db.session.commit()
            invalidate_wps_cache()
            return item
        return existing
    except Exception as e:
        db.session.rollback()
        return None


@wps_processes_bp.route("", methods=["GET"])
def get_wps_processes():
    archived = request.args.get("archived", "false").lower() == "true"
    if archived in _wps_cache:
        return jsonify(_wps_cache[archived])

    seed_wps_processes()
    query = WpsProcess.query.filter_by(archived=archived).order_by(WpsProcess.wps_no.asc())
    rows = query.all()
    data = [_serialize(r) for r in rows]
    _wps_cache[archived] = data
    return jsonify(data)


@wps_processes_bp.route("", methods=["POST"])
def create_or_update_wps_process():
    data = request.get_json() or {}
    wps_no = (data.get("wpsNo") or data.get("wps_no") or "").strip()
    process = (data.get("process") or "").strip()

    if not wps_no or not process:
        return jsonify({"error": "wpsNo and process are required."}), 400

    item = ensure_wps_process(wps_no, process)
    if not item:
        item = WpsProcess.query.filter(
            db.func.lower(WpsProcess.wps_no) == wps_no.lower(),
            db.func.lower(WpsProcess.process) == process.lower(),
        ).first()
    invalidate_wps_cache()
    return jsonify(_serialize(item) if hasattr(item, "id") else item), 200
