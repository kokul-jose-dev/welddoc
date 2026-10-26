"""The welder certificates in each pipe's SharePoint folder "06 Schweisserprüfung-VT2" (2026-10-26).

Before, a certificate was only ever ADDED, and only the first time a person appeared on a weld
of the pipe: replacing a welder left the old one's certificate in the folder, and the bulk edit
copied nothing at all. Now the folder is brought fully up to date whenever a weld's welder,
inspector, date or status changes - on any path (weld dialog, bulk edit, deleting materials,
striking ...): a session hook notes the pipes, and after the commit each is synchronised in the
background.

What belongs in the folder: the certificates of everybody who is welder or inspector on an
active or struck weld of the pipe (a struck weld was welded - it is part of the record):
  * a weld with a date: per process, the certificate that was valid on that date - the one with
    the earliest "valid until" on or after it (a renewed one is archived and keeps its PDF);
  * a weld without a date yet: the person's current (not archived) certificates.
Every certificate is its own file - WPQ_<name>_<no>_<process>_<certificate no>.pdf - and only
files WeldDoc made (WPQ_*) are touched: anything else in the folder stays.
"""
import threading
from datetime import date

from sqlalchemy import event, inspect as sa_inspect
from sqlalchemy.orm import Session

from app.database import db

CERT_FOLDER = "06 Schweisserprüfung-VT2"
PREFIX = "WPQ_"
_locks = {}
_locks_guard = threading.Lock()


# --- what the folder should hold -------------------------------------------------------------------

def _to_date(value):
    try:
        return date.fromisoformat(str(value).strip()[:10]) if value else None
    except ValueError:
        return None


def file_name(welder, cert):
    from app.sharepoint import _sanitize_name
    part = lambda v: _sanitize_name(str(v or "").strip()).replace(" ", "_")
    bits = [part(welder.name) or "Welder", part(welder.no), part(cert.process) or "General", part(cert.cert_no)]
    return PREFIX + "_".join(b for b in bits if b) + ".pdf"


def _certs_for(certs, on_day):
    """The certificates covering a weld: per process the one valid on that day, or - for a weld
    without a date - every current certificate."""
    usable = [c for c in certs if (c.pdf_url or "").strip()]
    if on_day is None:
        return [c for c in usable if not c.archived]
    by_process = {}
    for c in usable:
        by_process.setdefault((c.process or "").strip().lower(), []).append(c)
    picked = []
    for group in by_process.values():
        valid = [(_to_date(c.valid_until), c) for c in group]
        valid = [(d, c) for d, c in valid if d is None or d >= on_day]
        if not valid:
            continue
        first = min((d for d, _ in valid if d is not None), default=None)
        picked += [c for d, c in valid if d == first]
    return picked


def wanted_files(pipeline_id):
    """{file name: (welder, certificate)} for this pipe, and the people with no certificate."""
    from app.models.weld import Weld
    from app.models.welder import Welder, Certificate
    welds = Weld.query.filter(
        Weld.pipeline_id == pipeline_id,
        db.or_(Weld.archived == False, Weld.struck == True),  # noqa: E712
    ).all()
    days = {}
    for w in welds:
        for pid in (w.welder_id, w.inspector_id):
            if pid:
                days.setdefault(pid, set()).add(_to_date(w.date))
    wanted, missing = {}, []
    for pid, on_days in days.items():
        welder = db.session.get(Welder, pid)
        if welder is None:
            continue
        certs = Certificate.query.filter_by(welder_id=pid).all()
        found = False
        for d in on_days:
            for c in _certs_for(certs, d):
                wanted[file_name(welder, c)] = (welder, c)
                found = True
        if not found:
            missing.append(f"{welder.name} ({welder.no or welder.id})")
    return wanted, missing


# --- bringing the folder up to date ----------------------------------------------------------------

def sync(pipeline_id, apply=True):
    """Make the pipe's certificate folder hold exactly what wanted_files says (WPQ_* files only).
    Returns what was / would be done."""
    from flask import current_app
    from app.models.pipeline import Pipeline
    from app.models.project import Project
    from app.sharepoint import (list_pipeline_subfolder_files, delete_sharepoint_drive_item,
                                upload_to_pipeline_subfolder, _download_sharepoint_file_content)
    result = {"pipeline": pipeline_id, "removed": [], "added": [], "missing": [], "failed": []}
    pl = db.session.get(Pipeline, pipeline_id)
    pr = db.session.get(Project, pl.project_id) if pl else None
    if not pl or not pr or not pr.sharepoint_drive_id or not pr.sharepoint_folder_id:
        return result
    with _lock(pipeline_id):
        wanted, result["missing"] = wanted_files(pipeline_id)
        present = list_pipeline_subfolder_files(pr.sharepoint_drive_id, pr.sharepoint_folder_id, pl.no, CERT_FOLDER)
        present_names = {f.get("name") for f in present}
        for f in present:
            name = f.get("name") or ""
            if name.startswith(PREFIX) and name not in wanted:
                result["removed"].append(name)
                if apply and not delete_sharepoint_drive_item(pr.sharepoint_drive_id, f.get("id")):
                    result["failed"].append(name)
        for name, (welder, cert) in sorted(wanted.items()):
            if name in present_names:
                continue
            result["added"].append(name)
            if not apply:
                continue
            try:
                content = _download_sharepoint_file_content(cert.pdf_url)
                if not content or not upload_to_pipeline_subfolder(
                        pr.sharepoint_drive_id, pr.sharepoint_folder_id, pl.no, CERT_FOLDER, name,
                        content, "application/pdf"):
                    result["failed"].append(name)
            except Exception as e:
                result["failed"].append(name)
                current_app.logger.error(f"Certificate copy {name} to pipeline {pl.no} failed: {e}")
    if result["removed"] or result["added"] or result["failed"]:
        current_app.logger.info(f"Certificates of pipeline {pl.no}: {result}")
    return result


def _lock(pipeline_id):
    with _locks_guard:
        return _locks.setdefault(pipeline_id, threading.Lock())


# --- noticing the changes --------------------------------------------------------------------------

_WATCHED = ("welder_id", "inspector_id", "date", "archived", "struck")


def _after_flush(session, _ctx):
    from app.models.weld import Weld
    touched = session.info.setdefault("cert_sync_pipelines", set())
    for obj in session.new:
        if isinstance(obj, Weld) and (obj.welder_id or obj.inspector_id) and obj.pipeline_id:
            touched.add(obj.pipeline_id)
    for obj in session.deleted:
        if isinstance(obj, Weld) and obj.pipeline_id:
            touched.add(obj.pipeline_id)
    for obj in session.dirty:
        if isinstance(obj, Weld) and obj.pipeline_id:
            state = sa_inspect(obj)
            if any(state.attrs[k].history.has_changes() for k in _WATCHED):
                touched.add(obj.pipeline_id)


def _after_commit(session):
    pipelines = session.info.pop("cert_sync_pipelines", None)
    if not pipelines:
        return
    from flask import current_app, has_app_context
    if not has_app_context():
        return
    app = current_app._get_current_object()
    threads = [threading.Thread(target=_run, args=(app, pid), daemon=True) for pid in sorted(pipelines)]
    for t in threads:
        t.start()
    if app.config.get("CERT_SYNC_INLINE"):          # tests: wait until it is done
        for t in threads:
            t.join()


def _run(app, pipeline_id):
    with app.app_context():
        try:
            sync(pipeline_id)
        except Exception as e:                     # never breaks the save that triggered it
            app.logger.error(f"Certificate sync failed for pipeline {pipeline_id}: {e}")
        finally:
            db.session.remove()


def _after_rollback(session):
    session.info.pop("cert_sync_pipelines", None)


_installed = False


def init_pipeline_certs(app):
    global _installed
    if _installed:
        return
    event.listen(Session, "after_flush", _after_flush)
    event.listen(Session, "after_commit", _after_commit)
    event.listen(Session, "after_soft_rollback", lambda s, prev: _after_rollback(s))
    _installed = True
