"""Changing the specification of a material from a pipe (2026-10-22, agreed with IST).

A position in a pipe (pipeline material) points to a project material (specification +
certificate + heat number + WAZ), and every position of every pipe of the project that has the
same material points to the SAME project material. Rewriting that shared record changed the
material in every pipe at once - also in pipes that were already welded or exported. Now the
user chooses how far the change goes:

  A  "one"    only this position
  B  "pipe"   every position of this pipe with the same material
  C  "global" the material everywhere: every pipe of every project, and the global list
              (only offered when the new values are not an existing material of the project)

When the new values are a material the project already has, it is a SWAP: the positions are
switched to that existing material, nothing new is created (only A and B are offered).

Protected - never changed without the user asking for it:
  * locked positions (a weld on them has a welder or inspector, or they are struck): B and C
    list them, the user can tick them to include them; A on a locked position is refused.
  * pipes on final (status 5, final document exported): C leaves them as they are. Their old
    project material remembers what replaced it (replaced_by_id), and whoever opens such a
    pipe is asked whether to apply the change there too (see pending_changes / answer).

When nothing protected uses a project material it is simply changed in place - no copy, no
"replaced" link; the copy is only made when something has to keep the old values.
"""
from datetime import datetime

from app.database import db
from app.material_utils import (
    clean_str, normalize_gm_data, spec_key, find_matching_global_material,
    find_matching_project_material,
)
from app.models.global_material import GlobalMaterial
from app.models.pipeline import Pipeline
from app.models.pipeline_material import PipelineMaterial
from app.models.project_material import ProjectMaterial
from app.spec_values import canon_certificate

FINAL_STATUS = 5


class ChangeRefused(Exception):
    def __init__(self, code, message, status=409):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


# --- labels ---------------------------------------------------------------------------------------

def spec_label(gm, certificate=None, heat_no=None):
    """"Bogen 45° DIN 11865 · DN 15 · Ø 18.0 · 1.0 mm · 1.4435 · 3.1 · Heat ZB513" """
    parts = []
    if gm is not None:
        get = gm.get if isinstance(gm, dict) else (lambda k, d=None: getattr(gm, k, d))
        parts.append(clean_str(get("item_description")) or clean_str(get("category")))
        dns = [clean_str(get(f"dn{i}")) for i in range(1, 7)]
        parts.append(" × ".join(d for d in dns if d))
        parts.append(" × ".join(d for d in (clean_str(get(f)) for f in ("diameter", "diameter2", "diameter3")) if d))
        parts.append(" × ".join(d for d in (clean_str(get(f)) for f in ("thickness", "thickness2", "thickness3")) if d))
        parts.append(clean_str(get("material_code")))
        parts.append(clean_str(get("surface")))
    cert = canon_certificate(certificate)
    if cert:
        parts.append(str(cert))
    if clean_str(heat_no):
        parts.append(f"Heat {clean_str(heat_no)}")
    return " · ".join(p for p in parts if p)


def pm_label(pm):
    return spec_label(pm.global_material, pm.certificate, pm.heat_no) if pm else ""


# --- who is affected ------------------------------------------------------------------------------

class _Locks:
    """Locked position ids per pipeline, looked up once."""

    def __init__(self):
        self._cache = {}

    def __call__(self, pipeline_id):
        if pipeline_id not in self._cache:
            from app.routes.pipeline_materials import _locked_material_ids
            self._cache[pipeline_id] = _locked_material_ids(pipeline_id)
        return self._cache[pipeline_id]


def _pipelines(ids):
    return {p.id: p for p in Pipeline.query.filter(Pipeline.id.in_(ids)).all()} if ids else {}


def _row_info(r, pl):
    return {"id": r.id, "pipelineId": r.pipeline_id, "pipelineNo": pl.no if pl else "",
            "position": r.position or ""}


def _classify(rows, own_pipeline_id, locks):
    """Split active positions into free / locked / final (pipes on final other than this one)."""
    pls = _pipelines({r.pipeline_id for r in rows})
    out = {"free": [], "locked": [], "final": []}
    for r in rows:
        pl = pls.get(r.pipeline_id)
        if r.pipeline_id != own_pipeline_id and pl is not None and (pl.archived or (pl.status or 0) >= FINAL_STATUS):
            out["final"].append(r)
        elif r.id in locks(r.pipeline_id):
            out["locked"].append(r)
        else:
            out["free"].append(r)
    return out, pls


def _target_spec(m, specs, certificate, heat_no):
    old_pm = m.project_material
    norm = normalize_gm_data(specs or {})
    same_spec = old_pm.global_material is not None and spec_key(norm) == spec_key(old_pm.global_material)
    gm = old_pm.global_material if same_spec else find_matching_global_material(norm)
    cert = canon_certificate(certificate)
    heat = clean_str(heat_no)
    return old_pm, norm, same_spec, gm, cert, heat


def analyse(m, specs, certificate, heat_no):
    """What A / B / C would do - for the dialog. Nothing is changed."""
    old_pm, norm, same_spec, gm, cert, heat = _target_spec(m, specs, certificate, heat_no)
    unchanged = (same_spec and cert == canon_certificate(old_pm.certificate)
                 and heat.lower() == clean_str(old_pm.heat_no).lower())
    swap_pm = (find_matching_project_material(old_pm.project_id, gm.id, cert, heat, exclude_id=old_pm.id)
               if gm is not None and not unchanged else None)
    locks = _Locks()
    self_locked = m.id in locks(m.pipeline_id)

    pipe_rows = PipelineMaterial.query.filter_by(
        pipeline_id=m.pipeline_id, project_material_id=old_pm.id, archived=False).all()
    pipe_cls, pls = _classify([r for r in pipe_rows if r.id != m.id], m.pipeline_id, locks)

    result = {
        "unchanged": unchanged,
        "swap": swap_pm is not None,
        "swapTarget": None,
        "from": pm_label(old_pm),
        "to": spec_label(gm if gm is not None else norm, cert, heat),
        "selfLocked": self_locked,
        "pipe": {"count": 1 + len(pipe_cls["free"]),
                 "locked": [_row_info(r, pls.get(r.pipeline_id)) for r in pipe_cls["locked"]]},
        "global": None,
    }
    if swap_pm is not None:
        used = PipelineMaterial.query.filter_by(project_material_id=swap_pm.id, archived=False).all()
        upl = _pipelines({u.pipeline_id for u in used})
        waz = next((u.waz_no for u in used if u.waz_no), "")
        result["swapTarget"] = {
            "projectMaterialId": swap_pm.id, "label": pm_label(swap_pm), "wazNo": waz or "",
            "usedCount": len(used), "pipelines": sorted({upl[u.pipeline_id].no for u in used if u.pipeline_id in upl}),
        }
    else:
        rows = _global_rows(old_pm, same_spec)
        cls, gpls = _classify([r for r in rows if r.id != m.id], m.pipeline_id, locks)
        changed = [m] + cls["free"]
        finals = {}
        for r in cls["final"]:
            finals.setdefault(gpls[r.pipeline_id].no if r.pipeline_id in gpls else str(r.pipeline_id), []).append(r.position or "")
        result["global"] = {
            "count": len(changed),
            "pipelines": len({r.pipeline_id for r in changed}),
            "projects": len({r.project_material.project_id for r in changed if r.project_material}),
            "locked": [_row_info(r, gpls.get(r.pipeline_id)) for r in cls["locked"]],
            "final": [{"pipelineNo": k, "positions": sorted(v)} for k, v in sorted(finals.items())],
        }
    return result


def _global_rows(old_pm, same_spec):
    """Active positions C reaches: this project material, and - when the specification changes -
    every project material (any project) built on the same global material."""
    pm_ids = {old_pm.id}
    if not same_spec:
        pm_ids |= {p.id for p in ProjectMaterial.query.filter_by(
            global_material_id=old_pm.global_material_id, archived=False).all()}
    return PipelineMaterial.query.filter(
        PipelineMaterial.project_material_id.in_(pm_ids), PipelineMaterial.archived == False  # noqa: E712
    ).all()


# --- doing it -------------------------------------------------------------------------------------

def _actor():
    from app.event_log import current_actor
    email, name = current_actor()
    return name or email or ""


def _get_or_create_gm(norm):
    gm = find_matching_global_material(norm)
    if gm is not None:
        return gm
    from app.routes.dropdown_values import unhide_entered_values
    gm = GlobalMaterial(**{k: norm[k] for k in (
        "category", "item_description", "material_code", "dien_no", "surface",
        "diameter", "diameter2", "diameter3", "thickness", "thickness2", "thickness3",
        "dn1", "dn2", "dn3", "dn4", "dn5", "dn6")})
    unhide_entered_values(norm)
    db.session.add(gm)
    db.session.flush()
    return gm


def _same_melt(pm, cert, heat):
    return (clean_str(pm.heat_no).lower() == clean_str(heat).lower()
            and canon_certificate(pm.certificate) == canon_certificate(cert))


def _new_pm(project_id, gm_id, cert, heat, template, waz_pdf_url=None):
    """The project material with these values: the existing one, or a new one. A WAZ certificate
    belongs to one melt - it only comes along when certificate and heat number stay the same."""
    found = find_matching_project_material(project_id, gm_id, cert, heat)
    if found is not None:
        return found, False
    waz = ""
    if template is not None and _same_melt(template, cert, heat):
        waz = waz_pdf_url or template.waz_pdf_url or ""
    elif waz_pdf_url and (template is None or waz_pdf_url != template.waz_pdf_url):
        waz = waz_pdf_url                      # a different certificate the user attached for the new melt
    pm = ProjectMaterial(project_id=project_id, global_material_id=gm_id,
                         certificate=cert, heat_no=heat, waz_pdf_url=waz)
    db.session.add(pm)
    db.session.flush()
    return pm, True


def _mark_replaced(pm, target, note):
    pm.replaced_by_id = target.id
    pm.replaced_at = datetime.utcnow()
    pm.replaced_by = _actor()[:255]
    pm.replace_note = (note or "")[:500]


def _relink(rows, target):
    for r in rows:
        if r.project_material_id != target.id:
            r.project_material_id = target.id      # one by one, so the event log records each


def _referenced_elsewhere(pm, moving_ids):
    """Any position (also archived / struck ones) that keeps pointing at pm after the move."""
    return PipelineMaterial.query.filter(
        PipelineMaterial.project_material_id == pm.id, ~PipelineMaterial.id.in_(moving_ids or [0])
    ).first() is not None


def _change_pm(pm, gm_id, cert, heat, rows_move, note, waz_pdf_url=None, ensure_target=False):
    """Move rows_move of pm to (gm_id, cert, heat). In place when nothing else uses pm; merged
    into the existing material when one matches; otherwise a new one, and pm remembers it.
    ensure_target: even with nothing to move, make sure the newer material exists and pm points
    to it - so the pipes on final that kept pm can be asked about it."""
    work = {"created": [], "in_place": [], "targets": set()}
    moving_ids = [r.id for r in rows_move]
    if not rows_move:
        if ensure_target:
            target, created = _new_pm(pm.project_id, gm_id, cert, heat, pm, waz_pdf_url)
            if target.id != pm.id:
                _mark_replaced(pm, target, note)
                if created:
                    work["created"].append(target.id)
        return work
    existing = find_matching_project_material(pm.project_id, gm_id, cert, heat, exclude_id=pm.id)
    if existing is None and not _referenced_elsewhere(pm, moving_ids):
        # Nothing else uses it: change the material itself
        from app.global_waz import snapshot
        work["in_place"].append((pm.id, snapshot([pm]), pm.global_material_id, clean_str(pm.heat_no),
                                 canon_certificate(pm.certificate)))
        heat_changed = clean_str(pm.heat_no).lower() != clean_str(heat).lower()
        pm.global_material_id = gm_id
        pm.certificate = cert
        pm.heat_no = heat
        if heat_changed:
            # a new melt needs its own certificate - only one the user attached for it stays
            pm.waz_pdf_url = waz_pdf_url if (waz_pdf_url and waz_pdf_url != pm.waz_pdf_url) else ""
        work["targets"].add(pm.id)
        return work
    if existing is not None:
        target, created = existing, False
    else:
        target, created = _new_pm(pm.project_id, gm_id, cert, heat, pm, waz_pdf_url)
    _relink(rows_move, target)
    if created:
        work["created"].append(target.id)
    work["targets"].add(target.id)
    if _referenced_elsewhere(pm, moving_ids):
        _mark_replaced(pm, target, note)
    else:
        pm.archived = True                     # nothing left on it - merged into the target
        _mark_replaced(pm, target, note)
    return work


def apply(m, scope, specs, certificate, heat_no, include_locked=(), waz_pdf_url=None):
    """Do A / B / C. Commits. Returns a summary for the user."""
    if scope not in ("one", "pipe", "global"):
        raise ChangeRefused("bad_scope", "Choose A (only this material), B (whole pipe) or C (everywhere).", 400)
    if m.archived:
        raise ChangeRefused("material_archived", "This material is archived and cannot be changed.")
    info = analyse(m, specs, certificate, heat_no)
    if info["unchanged"]:
        return {"changed": 0, "swap": False, "kept": [], "final": []}
    if info["selfLocked"]:
        raise ChangeRefused(
            "material_locked",
            "This material is locked: a weld on it already has a welder or inspector. "
            "To correct it, strike it and add the right material.")
    if info["swap"] and scope == "global":
        raise ChangeRefused("swap_not_global",
                            "These values are an existing material - it can be swapped in this pipe (A or B), "
                            "not changed everywhere.", 400)

    old_pm, norm, same_spec, gm, cert, heat = _target_spec(m, specs, certificate, heat_no)
    if gm is None:
        gm = _get_or_create_gm(norm)
    locks = _Locks()
    wanted_locked = {int(i) for i in (include_locked or []) if str(i).isdigit()}
    note = f"{pm_label(old_pm)}  →  {spec_label(gm, cert, heat)}"
    works, touched_pipelines, kept, finals = [], {m.pipeline_id}, [], []

    if scope in ("one", "pipe"):
        rows = [m]
        if scope == "pipe":
            others = PipelineMaterial.query.filter_by(
                pipeline_id=m.pipeline_id, project_material_id=old_pm.id, archived=False).all()
            for r in others:
                if r.id == m.id:
                    continue
                if r.id in locks(r.pipeline_id) and r.id not in wanted_locked:
                    kept.append(r)
                else:
                    rows.append(r)
        works.append(_change_pm(old_pm, gm.id, cert, heat, rows, note, waz_pdf_url))
        changed = len(rows)
    else:
        changed = 0
        pms = [old_pm]
        if not same_spec:
            pms += [p for p in ProjectMaterial.query.filter_by(
                global_material_id=old_pm.global_material_id, archived=False).all() if p.id != old_pm.id]
        for pm in pms:
            rows = PipelineMaterial.query.filter_by(project_material_id=pm.id, archived=False).all()
            cls, pls = _classify(rows, m.pipeline_id, locks)
            move = cls["free"] + [r for r in cls["locked"] if r.id in wanted_locked or r.id == m.id]
            kept += [r for r in cls["locked"] if r not in move]
            finals += cls["final"]
            p_cert, p_heat = (cert, heat) if pm.id == old_pm.id else (pm.certificate, pm.heat_no)
            works.append(_change_pm(pm, gm.id, p_cert, p_heat, move, note,
                                    waz_pdf_url if pm.id == old_pm.id else None,
                                    ensure_target=bool(cls["final"])))
            touched_pipelines |= {r.pipeline_id for r in rows}
            changed += len(move)
        # The wrong specification leaves the global list; whoever still uses it (pipes on final,
        # locked positions) keeps seeing it, and it remembers its correction.
        if not same_spec:
            old_gm = db.session.get(GlobalMaterial, old_pm.global_material_id)
            if old_gm is not None and old_gm.id != gm.id:
                old_gm.archived = True
                old_gm.replaced_by_id = gm.id

    from app.event_log import log_event
    log_event("pipeline_material", m.id, "material_swap" if info["swap"] else "material_change", changes={
        "scope": {"one": "A - only this material", "pipe": "B - whole pipe", "global": "C - everywhere"}[scope],
        "from": info["from"], "to": spec_label(gm, cert, heat), "positions_changed": changed,
        "locked_kept": [f"{r.position}" for r in kept],
        "final_kept": sorted({str(r.pipeline_id) for r in finals}),
    }, pipeline_id=m.pipeline_id, project_id=old_pm.project_id)
    db.session.commit()
    _after_change(works, touched_pipelines)
    pls = _pipelines({r.pipeline_id for r in kept + finals})
    return {
        "changed": changed, "swap": info["swap"],
        "kept": [_row_info(r, pls.get(r.pipeline_id)) for r in kept],
        "final": sorted({pls[r.pipeline_id].no for r in finals if r.pipeline_id in pls}),
    }


def _after_change(works, pipeline_ids):
    """WAZ numbers per pipe, WAZ packages, global WAZ copies - the same follow-ups as before."""
    from flask import current_app
    from app.routes.pipeline_materials import _sync_pipeline_waz_nos
    from app.routes.project_materials import _regenerate_waz_in_background, _drop_stale_waz_packages, _copy_waz_file_for_pm
    from app.global_waz import after_spec_change, after_removed
    for pid in sorted(pipeline_ids):
        try:
            _sync_pipeline_waz_nos(pid)
        except Exception as e:                 # pragma: no cover - logged, never blocks the change
            db.session.rollback()
            current_app.logger.error(f"WAZ number sync failed for pipeline {pid}: {e}")
    db.session.commit()
    for w in works:
        for pm_id, before, gm_before, heat_before, cert_before in w["in_place"]:
            pm = db.session.get(ProjectMaterial, pm_id)
            if pm is None:
                continue
            if heat_before.lower() != clean_str(pm.heat_no).lower() and not pm.waz_pdf_url:
                _drop_stale_waz_packages(pm.id)
                db.session.commit()
                if before:
                    after_removed(before[pm.id])
            elif before:
                after_spec_change(before)
        for pm_id in w["created"]:
            pm = db.session.get(ProjectMaterial, pm_id)
            if pm is not None and pm.waz_pdf_url:
                _copy_in_background(pm.id)
        for pm_id in w["targets"]:
            _regenerate_waz_in_background(pm_id)


def _copy_in_background(pm_id):
    """A new project material carrying the certificate gets its own copy, named after its specs."""
    import threading
    from flask import current_app
    from app.routes.project_materials import _copy_waz_file_for_pm
    app = current_app._get_current_object()

    def _bg():
        with app.app_context():
            pm = db.session.get(ProjectMaterial, pm_id)
            if pm is not None:
                try:
                    _copy_waz_file_for_pm(pm)
                except Exception as e:      # pragma: no cover
                    app.logger.error(f"WAZ copy failed for project material {pm_id}: {e}")

    threading.Thread(target=_bg, daemon=True).start()


# --- the other ways a material is edited: the project's and the global material list ---------------

def _protected_split(rows):
    """(free, protected) active positions - protected = locked, or in a pipe on final."""
    cls, _ = _classify(rows, None, _Locks())
    return cls["free"], cls["locked"] + cls["final"], cls["final"]


def guard_project_material_edit(pm, gm_id, cert, heat, waz_pdf_url=None):
    """Editing a project material (project material list): when locked positions or pipes on
    final use it, they keep it; the others move to the edited values. Returns the material the
    others now use - or None when nothing is protected (the edit goes ahead as before)."""
    if (pm.global_material_id == gm_id and canon_certificate(pm.certificate) == canon_certificate(cert)
            and clean_str(pm.heat_no).lower() == clean_str(heat).lower()):
        return None
    rows = PipelineMaterial.query.filter_by(project_material_id=pm.id, archived=False).all()
    free, protected, finals = _protected_split(rows)
    if not protected:
        return None
    gm = db.session.get(GlobalMaterial, gm_id)
    note = f"{pm_label(pm)}  →  {spec_label(gm, cert, heat)}"
    work = _change_pm(pm, gm_id, cert, heat, free, note, waz_pdf_url, ensure_target=True)
    target = next((db.session.get(ProjectMaterial, i) for i in work["targets"]), None)         or (db.session.get(ProjectMaterial, pm.replaced_by_id) if pm.replaced_by_id else None)
    from app.event_log import log_event
    log_event("project_material", pm.id, "material_change", changes={
        "scope": "project material list", "from": pm_label(pm), "to": note.split("→")[-1].strip(),
        "positions_changed": len(free), "kept": len(protected)}, project_id=pm.project_id)
    db.session.commit()
    _after_change([work], {r.pipeline_id for r in rows})
    return target


def guard_global_material_edit(gm, norm):
    """Editing a global material (global list): when locked positions or pipes on final use it,
    it is not rewritten - the corrected specification becomes a material of its own, everything
    unprotected moves to it, and the old one leaves the list. Returns the corrected global
    material, or None when nothing is protected (the edit goes ahead as before)."""
    if spec_key(norm) == spec_key(gm):
        return None
    pms = ProjectMaterial.query.filter_by(global_material_id=gm.id, archived=False).all()
    rows_by_pm = {pm.id: PipelineMaterial.query.filter_by(project_material_id=pm.id, archived=False).all() for pm in pms}
    split = {pid: _protected_split(rows) for pid, rows in rows_by_pm.items()}
    if not any(prot for _, prot, _ in split.values()):
        return None
    new_gm = find_matching_global_material(norm, exclude_id=gm.id) or _get_or_create_gm(norm)
    works, touched = [], set()
    for pm in pms:
        free, prot, finals = split[pm.id]
        note = f"{pm_label(pm)}  →  {spec_label(new_gm, pm.certificate, pm.heat_no)}"
        works.append(_change_pm(pm, new_gm.id, pm.certificate, pm.heat_no, free, note, ensure_target=bool(finals)))
        touched |= {r.pipeline_id for r in rows_by_pm[pm.id]}
    gm.archived = True
    gm.replaced_by_id = new_gm.id
    from app.event_log import log_event
    log_event("global_material", gm.id, "material_change", changes={
        "scope": "global material list", "from": spec_label(gm), "to": spec_label(new_gm)})
    db.session.commit()
    _after_change(works, touched)
    return new_gm


# --- pipes on final: asked later ------------------------------------------------------------------

def _latest(pm):
    """Follow replaced_by to the newest active project material (None if there is none)."""
    seen, cur = set(), pm
    while cur is not None and cur.replaced_by_id and cur.id not in seen and len(seen) < 20:
        seen.add(cur.id)
        cur = db.session.get(ProjectMaterial, cur.replaced_by_id)
    if cur is None or cur.id == pm.id or cur.archived:
        return None
    return cur


def pending_changes(pipeline_id):
    """Materials of a pipe on final that were changed everywhere after it was finished."""
    from app.models.material_change_answer import MaterialChangeAnswer
    pl = db.session.get(Pipeline, pipeline_id)
    if pl is None or (pl.status or 0) < FINAL_STATUS:
        return []
    rows = PipelineMaterial.query.filter_by(pipeline_id=pipeline_id, archived=False).all()
    by_pm = {}
    for r in rows:
        pm = r.project_material
        if pm is None or not pm.replaced_by_id:
            continue
        latest = _latest(pm)
        if latest is None:
            continue
        kept = MaterialChangeAnswer.query.filter_by(
            pipeline_id=pipeline_id, project_material_id=pm.id, replacement_id=latest.id, answer="keep").first()
        if kept is not None:
            continue
        e = by_pm.setdefault(pm.id, {
            "projectMaterialId": pm.id, "replacementId": latest.id,
            "from": pm_label(pm), "to": pm_label(latest), "positions": [],
            "changedAt": pm.replaced_at.isoformat() if pm.replaced_at else None,
            "changedBy": pm.replaced_by or "",
        })
        e["positions"].append(r.position or "")
    for e in by_pm.values():
        e["positions"].sort()
    return sorted(by_pm.values(), key=lambda e: e["positions"])


def answer(pipeline_id, pm_id, decision):
    """Apply the newer material in this pipe, or keep the old one (and do not ask again)."""
    from app.models.material_change_answer import MaterialChangeAnswer
    if decision not in ("apply", "keep"):
        raise ChangeRefused("bad_answer", "Answer apply or keep.", 400)
    pm = db.session.get(ProjectMaterial, pm_id)
    latest = _latest(pm) if pm is not None else None
    if latest is None:
        raise ChangeRefused("nothing_to_apply", "This material has no newer version any more.", 404)
    db.session.add(MaterialChangeAnswer(
        pipeline_id=pipeline_id, project_material_id=pm.id, replacement_id=latest.id,
        answer=decision, answered_by=_actor()[:255], answered_at=datetime.utcnow()))
    moved = 0
    if decision == "apply":
        rows = PipelineMaterial.query.filter_by(pipeline_id=pipeline_id, project_material_id=pm.id, archived=False).all()
        _relink(rows, latest)
        moved = len(rows)
    from app.event_log import log_event
    log_event("pipeline", pipeline_id, "material_change_" + decision, changes={
        "from": pm_label(pm), "to": pm_label(latest), "positions_changed": moved}, pipeline_id=pipeline_id,
        project_id=pm.project_id)
    db.session.commit()
    if decision == "apply":
        _after_change([{"created": [], "in_place": [], "targets": {latest.id}}], {pipeline_id})
    return {"answer": decision, "changed": moved}
