import itertools
import re
from datetime import datetime
from flask import Blueprint, request, jsonify
from app.database import db
from app.models.pipeline_material import PipelineMaterial, pipeline_material_connections
from app.models.project_material import ProjectMaterial
from app.models.weld import Weld
from app.material_utils import clean_str, find_matching_project_material

pipeline_materials_bp = Blueprint("pipeline_materials", __name__)


def _pos_letter(n):
    """Convert position number to Excel-style letter: 1→A, 26→Z, 27→AA, 28→AB, etc."""
    try:
        n = int(n)
        if n <= 0:
            return ""
        res = ""
        while n > 0:
            n, r = divmod(n - 1, 26)
            res = chr(65 + r) + res
        return res
    except (ValueError, TypeError):
        return str(n) if n is not None else ""


def _letter_to_pos(s):
    """Convert Excel-style letter to number: A→1, Z→26, AA→27, AB→28, etc."""
    if not s:
        return 0
    s = str(s).strip().upper()
    if s.isalpha():
        num = 0
        for ch in s:
            num = num * 26 + (ord(ch) - 64)
        return num
    try:
        return int(s)
    except (ValueError, TypeError):
        return 0


def _gm_dim_props(gm):
    if not gm:
        return {"dns": [], "diameters": [], "thicknesses": []}
    dns = [getattr(gm, f"dn{i}") for i in range(1, 7) if getattr(gm, f"dn{i}")]
    dias = [d for d in [gm.diameter, gm.diameter2, gm.diameter3] if d]
    thks = [t for t in [gm.thickness, gm.thickness2, gm.thickness3] if t]
    return {"dns": dns, "diameters": dias, "thicknesses": thks}


@pipeline_materials_bp.route("", methods=["GET"])
def get_pipeline_materials():
    pipeline_id = request.args.get("pipelineId", type=int)
    archived = request.args.get("archived", "false").lower() == "true"
    if pipeline_id and not archived:
        try:
            _sync_pipeline_waz_nos(pipeline_id)
        except Exception:
            db.session.rollback()
    query = PipelineMaterial.query.filter_by(archived=archived)
    if pipeline_id:
        query = query.filter_by(pipeline_id=pipeline_id)
    rows = query.order_by(db.func.length(PipelineMaterial.position), PipelineMaterial.position).all()
    return jsonify([_serialize(m) for m in rows])


@pipeline_materials_bp.route("/<int:pm_id>", methods=["GET"])
def get_pipeline_material(pm_id):
    include_context = request.args.get("includeContext", "false").lower() == "true"
    m = PipelineMaterial.query.get_or_404(pm_id)
    if include_context:
        from app.routes.pipeline_detail import get_pipeline_detail
        return get_pipeline_detail(m.pipeline_id)
    return jsonify(_serialize(m))


@pipeline_materials_bp.route("", methods=["POST"])
def create_pipeline_material():
    """Create a new pipeline material from a project material."""
    data = request.get_json()
    pipeline_id = data["pipelineId"]
    project_material_id = data["projectMaterialId"]

    # A new material connected to two parts that are welded to each other is "inserted
    # between" them, which deletes their weld. Welds with recorded work need confirming first.
    new_pm = ProjectMaterial.query.get(project_material_id)
    new_is_wire = bool(new_pm and new_pm.global_material and
                       (new_pm.global_material.category or "").strip().lower() == "welding wire")
    locked = _numbering_frozen(pipeline_id)
    if locked and "connections" in data and not new_is_wire:
        refused = _locked_connection_refusal(pipeline_id, None, [], data["connections"])
        if refused:
            return refused
    if "connections" in data and not new_is_wire and not locked:
        ask = _confirm_weld_deletion(_welds_deleted_by_connection_change(
            pipeline_id, None, [], data["connections"],
            start_of_plumbing=bool(data.get("startOfPlumbing"))), data)
        if ask:
            return ask

    # Determine position (next sequential letter, preventing duplicates)
    existing_mats = PipelineMaterial.query.filter_by(
        pipeline_id=pipeline_id, archived=False
    ).all()
    existing_positions = {m.position for m in _lettered_materials(pipeline_id) if m.position}
    req_pos = (data.get("position") or "").strip().upper()
    if req_pos and req_pos not in existing_positions and not locked:
        position = req_pos
    elif locked:
        # Letters are fixed once someone has welded: the new material takes the next letter
        # after every letter in use - struck-through materials keep theirs.
        position = _next_free_letter(pipeline_id)
    else:
        position = _pos_letter(len(existing_mats) + 1)

    # Auto-assign WAZ number
    waz_no = _assign_waz_no(pipeline_id, project_material_id)

    # Check if another material with the same project material spec already has a waz_package_url in this pipeline
    waz_package_url = None
    pm_curr = ProjectMaterial.query.get(project_material_id)
    if pm_curr and pm_curr.certificate and pm_curr.heat_no:
        c_curr = pm_curr.certificate.strip().lower()
        h_curr = pm_curr.heat_no.strip().lower()
        gm_curr = pm_curr.global_material_id
        existing_sibling = PipelineMaterial.query.filter_by(
            pipeline_id=pipeline_id, archived=False
        ).all()
        for sib in existing_sibling:
            if sib.project_material:
                s_pm = sib.project_material
                if (s_pm.global_material_id == gm_curr and
                    (s_pm.certificate or "").strip().lower() == c_curr and
                    (s_pm.heat_no or "").strip().lower() == h_curr and
                    sib.waz_package_url):
                    waz_package_url = sib.waz_package_url
                    break

    m = PipelineMaterial(
        pipeline_id=pipeline_id,
        project_material_id=project_material_id,
        position=position,
        waz_no=waz_no,
        waz_package_url=waz_package_url,
        start_of_plumbing=data.get("startOfPlumbing", False),
        end_of_plumbing=data.get("endOfPlumbing", False),
    )
    db.session.add(m)
    db.session.commit()

    # Handle connections (skip welding wire)
    is_wire = False
    if m.project_material and m.project_material.global_material:
        is_wire = (m.project_material.global_material.category or "").strip().lower() == "welding wire"

    if "connections" in data:
        if not is_wire:
            _update_connections(m, data["connections"], pipeline_id)
            db.session.commit()
            if locked:
                _place_in_gap(m, pipeline_id)
    elif not is_wire:
        # Auto-connect to previous non-wire material (chain: A→B→C→D)
        all_prev = PipelineMaterial.query.filter_by(
            pipeline_id=pipeline_id, archived=False
        ).filter(PipelineMaterial.id != m.id).order_by(
            PipelineMaterial.position.desc()
        ).all()
        prev = next((p for p in all_prev if not (p.project_material and p.project_material.global_material and (p.project_material.global_material.category or '').strip().lower() == 'welding wire')), None)
        if prev:
            if prev not in m.connections:
                m.connections.append(prev)
            if m not in prev.connections:
                prev.connections.append(m)
            db.session.commit()
            # Auto-create weld between them
            weld_count = Weld.query.filter_by(pipeline_id=pipeline_id, archived=False).count()
            new_weld = Weld(
                pipeline_id=pipeline_id,
                weld_no="0" if locked else str(weld_count + 1),   # "0": numbered below
                material_a_id=prev.id,
                material_b_id=m.id,
                between_a=prev.position,
                between_b=m.position,
            )
            db.session.add(new_weld)
            db.session.commit()
            if locked:
                _sync_and_renumber_welds(pipeline_id)
    if not locked:
        _sync_sort_order(pipeline_id)
    elif m.sort_order is None:
        _place_in_gap(m, pipeline_id)

    # Copy existing WAZ PDF to pipeline folder in background
    import threading
    from flask import current_app
    app = current_app._get_current_object()
    mat_id = m.id

    def _bg_copy():
        with app.app_context():
            mat = PipelineMaterial.query.get(mat_id)
            if mat:
                _copy_waz_to_pipeline_folder(mat)

    threading.Thread(target=_bg_copy, daemon=True).start()

    return jsonify(_serialize(m)), 201


@pipeline_materials_bp.route("/<int:pm_id>", methods=["POST"])
def edit_pipeline_material(pm_id):
    """Edit a pipeline material (position, connections, start/end)."""
    m = PipelineMaterial.query.get_or_404(pm_id)
    data = request.get_json()

    # Once a welder or inspector is on a weld of this pipeline, its letters and connections
    # are part of the record: the letter stays, a connection can be added but not removed,
    # and archiving strikes the material and its welds through instead of deleting them.
    locked = _numbering_frozen(m.pipeline_id)
    if m.struck and data.get("archived") is False:
        return _struck_refusal()
    if locked:
        data.pop("position", None)
        if data.get("archived") and m.archived:
            data.pop("archived")
        if data.get("archived") and not m.archived:
            reason = clean_str(data.get("archiveReason"))
            if not reason:
                return _reason_required(m)
            _strike_pipeline_material(m, reason)
            return jsonify(_serialize(m)), 200
        if "connections" in data and not _is_wire(m) and not m.archived:
            refused = _locked_connection_refusal(
                m.pipeline_id, m, [c for c in m.connections if not c.archived], data["connections"])
            if refused:
                return refused

    # Welds this edit would delete (archiving the material, removing a connection, the
    # "inserted between" rule). Worked out before anything is changed; welds with recorded
    # work need the user's confirmation first.
    new_pos = data.get("position") or m.position
    at_risk = []        # archiving deletes nothing (its welds are archived with it) - no question
    if "connections" in data and not _is_wire(m) and not locked:
        at_risk += _welds_deleted_by_connection_change(
            m.pipeline_id, new_pos, [c for c in m.connections], data["connections"],
            own_id=m.id, start_of_plumbing=bool(data.get("startOfPlumbing", m.start_of_plumbing)))
    ask = _confirm_weld_deletion(at_risk, data)
    if ask:
        return ask

    # The specs may already have been rewritten by the global/project material calls that run
    # before this one, so the client sends the global material id it pointed at beforehand.
    # Global materials are find-or-create on an exact match, so a different id means the
    # specifications changed - and with them the WAZ cover page.
    waz_before = _waz_fingerprint(m)
    pkg_url_before = m.waz_package_url
    # Editing one material can renumber OTHERS (_assign_waz_no / _sync_pipeline_waz_nos).
    # The WAZ number is printed on the cover and baked into the filename, so any material
    # whose number moves needs its package rebuilt too - not just the one being edited.
    _pipeline_rows_before = PipelineMaterial.query.filter_by(
        pipeline_id=m.pipeline_id, archived=False
    ).all()
    waz_nos_before = {r.id: r.waz_no for r in _pipeline_rows_before}
    # Also remember which package files were in use. When two materials merge back onto one
    # WAZ number the dropped number's file is left referenced by nothing, and by then the
    # database no longer knows its URL - so it has to be captured up front.
    pkg_urls_before = {r.waz_package_url for r in _pipeline_rows_before if r.waz_package_url}
    prev_gm_id = data.get("prevGlobalMaterialId")
    try:
        prev_gm_id = int(prev_gm_id) if prev_gm_id is not None else None
    except (TypeError, ValueError):
        prev_gm_id = None
    # Same story for the heat number: it is rewritten by the project-material call that runs
    # before this one, so the client sends what it was beforehand.
    prev_heat = data.get("prevHeatNo") if "prevHeatNo" in data else None

    if "position" in data:
        m.position = data["position"]
    if "startOfPlumbing" in data:
        m.start_of_plumbing = data["startOfPlumbing"]
    if "endOfPlumbing" in data:
        m.end_of_plumbing = data["endOfPlumbing"]
    if "projectMaterialId" in data:
        m.project_material_id = data["projectMaterialId"]
    if "archived" in data:
        m.archived = data["archived"]
        if data["archived"]:
            _archive_pipeline_material(m, clean_str(data.get("archiveReason")))
        elif not locked:
            # Before welding: back to its old place, with its connections and welds
            _restore_in_place(m)
        else:
            _clear_archive_log(m)
            db.session.commit()
            # Its letter was released on archive and it comes back with no connections,
            # so it goes to the end of the run until someone reconnects it.
            if not m.position:
                if locked:
                    m.position = _next_free_letter(m.pipeline_id)
                else:
                    active = PipelineMaterial.query.filter_by(
                        pipeline_id=m.pipeline_id, archived=False
                    ).count()
                    m.position = _pos_letter(max(active, 1))
                m.sort_order = None
                db.session.commit()
                if locked:
                    _place_in_gap(m, m.pipeline_id)
            _renumber_positions(m.pipeline_id)
            _sync_pipeline_waz_nos(m.pipeline_id)

    if "wazNo" in data:
        m.waz_no = data["wazNo"]

    pm = m.project_material
    new_cert = data.get("certificate", "")
    new_heat = data.get("heatNo", "")
    pm_changed = False

    if new_cert or new_heat:
        cert = clean_str(new_cert or pm.certificate)
        heat = clean_str(new_heat or pm.heat_no)
        cur_cert = clean_str(pm.certificate)
        cur_heat = clean_str(pm.heat_no)
        if cert != cur_cert or heat != cur_heat:
            # If existing project material has no cert/heat yet, just fill it in
            if not cur_cert and not cur_heat:
                pm.certificate = cert
                pm.heat_no = heat
                pm_changed = True
            else:
                # Cert/heat changed — find or create a separate project material
                existing_pm = find_matching_project_material(
                    pm.project_id, pm.global_material_id, cert, heat
                )
                if existing_pm:
                    m.project_material_id = existing_pm.id
                    pm = existing_pm
                else:
                    new_pm = ProjectMaterial(
                        project_id=pm.project_id,
                        global_material_id=pm.global_material_id,
                        certificate=cert,
                        heat_no=heat,
                        waz_pdf_url=pm.waz_pdf_url,
                    )
                    db.session.add(new_pm)
                    db.session.flush()
                    m.project_material_id = new_pm.id
                    pm = new_pm
                pm_changed = True
        else:
            pm.certificate = cert
            pm.heat_no = heat
            pm_changed = True

    if "wazPdfUrl" in data:
        pm.waz_pdf_url = data["wazPdfUrl"]
        pm_changed = True

    # Auto-assign / sync WAZ numbers across the pipeline when heat/certificate changes
    if pm_changed:
        if pm.certificate and pm.heat_no:
            if not m.waz_no:
                m.waz_no = _assign_waz_no(m.pipeline_id, m.project_material_id)
        else:
            m.waz_no = None
            m.waz_package_url = None

    db.session.commit()
    _sync_pipeline_waz_nos(m.pipeline_id)
    if "position" in data:
        _refresh_weld_labels(m.pipeline_id)
        db.session.commit()

    if "connections" in data:
        _update_connections(m, data["connections"], m.pipeline_id)
        db.session.commit()

    # The certificate behind this row may have just been dropped, because a changed heat
    # number always requires a new one. A package built from the old certificate describes a
    # different melt, so it goes with it instead of staying on the row.
    if m.project_material and not m.project_material.waz_pdf_url and m.waz_package_url:
        m.waz_package_url = None
        db.session.commit()

    # Details on the cover page changed -> the stored package no longer matches. Rebuild it in
    # the background so saving stays responsive (it downloads, merges and re-uploads a PDF).
    regen_ids = []
    if m.project_material and m.project_material.waz_pdf_url and m.waz_no:
        specs_changed = prev_gm_id is not None and prev_gm_id != m.project_material.global_material_id
        heat_changed = prev_heat is not None and clean_str(prev_heat).lower() != clean_str(m.project_material.heat_no).lower()
        if (specs_changed or heat_changed or _waz_fingerprint(m) != waz_before
                or (pkg_url_before and not m.waz_package_url)):
            regen_ids.append(m.id)

    for r in PipelineMaterial.query.filter_by(pipeline_id=m.pipeline_id, archived=False).all():
        if r.id in regen_ids or not r.waz_no:
            continue
        if waz_nos_before.get(r.id) != r.waz_no and r.project_material and r.project_material.waz_pdf_url:
            regen_ids.append(r.id)

    if regen_ids:
        import threading
        from flask import current_app, session as flask_session
        app = current_app._get_current_object()
        actor = flask_session.get("user", {}).get("name", "") if flask_session else ""

        def _bg_regen(ids, urls_before):
            with app.app_context():
                done_specs = set()
                for mat_id in ids:
                    try:
                        mat = PipelineMaterial.query.get(mat_id)
                        mat_pm = mat.project_material if mat else None
                        if not mat_pm:
                            continue
                        # Materials sharing a spec share one package file - rebuild it once
                        key = (
                            mat_pm.global_material_id,
                            (mat_pm.certificate or "").strip().lower(),
                            (mat_pm.heat_no or "").strip().lower(),
                        )
                        if key in done_specs:
                            continue
                        done_specs.add(key)
                        _regenerate_waz_package(mat_id, user_name=actor)
                    except Exception as e:
                        app.logger.error(f"WAZ regeneration failed for material {mat_id}: {e}")
                try:
                    _delete_unreferenced_waz_packages(urls_before)
                except Exception as e:
                    app.logger.error(f"WAZ orphan cleanup failed: {e}")

        threading.Thread(target=_bg_regen, args=(list(regen_ids), set(pkg_urls_before)), daemon=True).start()

    return jsonify(_serialize(m)), 200


@pipeline_materials_bp.route("/<int:pm_id>/upload-waz", methods=["POST"])
def upload_waz_for_pipeline_material(pm_id):
    """Upload WAZ document — saves to project material, copies to pipeline/WAZ folder with cover page."""
    from app.models.project import Project
    from app.models.pipeline import Pipeline
    from app.models.client import Client
    from app.sharepoint import upload_waz_to_project_folder, upload_to_pipeline_waz_folder
    from app.waz_cover import generate_waz_cover_page
    from datetime import date

    m = PipelineMaterial.query.get_or_404(pm_id)
    pm = m.project_material
    if "file" not in request.files:
        return jsonify({"error": "No file provided"}), 400

    file = request.files["file"]
    if not file.filename:
        return jsonify({"error": "Empty filename"}), 400

    file_content = file.read()
    content_type = file.content_type or "application/pdf"

    project = Project.query.get(pm.project_id)
    if not project.sharepoint_drive_id or not project.sharepoint_folder_id:
        return jsonify({"error": "No SharePoint folder configured for this project."}), 400

    from app.sharepoint import upload_waz_to_project_folder, upload_to_pipeline_waz_folder, format_waz_filename

    gm = pm.global_material
    dims = _gm_dim_props(gm)
    proj_waz_name = format_waz_filename(
        item_desc=gm.item_description if gm else "",
        dn=gm.dn1 if gm else "",
        diameter=gm.diameter if gm else "",
        thickness=gm.thickness if gm else "",
        dns=dims["dns"],
        diameters=dims["diameters"],
        thicknesses=dims["thicknesses"],
        material_code=gm.material_code if gm else "",
        surface=gm.surface if gm else "",
        heat_no=pm.heat_no or "",
    )

    # 1. Upload to project-level WAZ folder
    url = upload_waz_to_project_folder(
        project.sharepoint_drive_id,
        project.sharepoint_folder_id,
        proj_waz_name,
        file_content,
        content_type,
    )

    if not url:
        return jsonify({"error": "Failed to upload to SharePoint"}), 500

    pm.waz_pdf_url = url
    if not m.waz_no and pm.certificate and pm.heat_no:
        m.waz_no = _assign_waz_no(m.pipeline_id, m.project_material_id)
    # 2. Generate Cover Letter, merge with raw WAZ PDF, and upload package to pipeline WAZ folder
    _build_and_save_waz_package(m, file_content=file_content)

    # Sync package URL and WAZ no across all pipeline materials sharing this exact project material spec
    if pm.certificate and pm.heat_no:
        c_norm = pm.certificate.strip().lower()
        h_norm = pm.heat_no.strip().lower()
        gm_norm = pm.global_material_id
        siblings = PipelineMaterial.query.filter_by(
            pipeline_id=m.pipeline_id, archived=False
        ).filter(PipelineMaterial.id != m.id).all()
        for sib in siblings:
            if sib.project_material:
                s_pm = sib.project_material
                if (s_pm.global_material_id == gm_norm and
                    (s_pm.certificate or "").strip().lower() == c_norm and
                    (s_pm.heat_no or "").strip().lower() == h_norm):
                    sib.waz_no = m.waz_no
                    sib.waz_package_url = m.waz_package_url
        db.session.commit()

    return jsonify(_serialize(m)), 200


@pipeline_materials_bp.route("/<int:pm_id>/waz-package", methods=["GET"])
def get_waz_package(pm_id):
    """View WAZ document merged with Cover Letter."""
    from flask import redirect, send_file
    import io
    m = PipelineMaterial.query.get_or_404(pm_id)
    if m.waz_package_url:
        return redirect(m.waz_package_url)

    pkg_url, pkg_bytes = _build_and_save_waz_package_with_bytes(m)
    if pkg_bytes:
        filename = f"WAZ_{m.waz_no or 'WAZ'}.pdf"
        return send_file(io.BytesIO(pkg_bytes), mimetype="application/pdf", as_attachment=False, download_name=filename)
    elif m.project_material and m.project_material.waz_pdf_url:
        return redirect(m.project_material.waz_pdf_url)
    return jsonify({"error": "No WAZ document available"}), 404


@pipeline_materials_bp.route("/<int:pm_id>", methods=["DELETE"])
def delete_pipeline_material(pm_id):
    """Archive a pipeline material with connection bridging, weld cleanup, and WAZ SharePoint sync."""
    m = PipelineMaterial.query.get_or_404(pm_id)
    data = request.get_json(silent=True) or {}
    if m.archived:
        return jsonify({"ok": True}), 200
    if _numbering_frozen(m.pipeline_id):
        reason = clean_str(data.get("archiveReason"))
        if not reason:
            return _reason_required(m)
        _strike_pipeline_material(m, reason)
        return jsonify({"ok": True}), 200
    _archive_pipeline_material(m, clean_str(data.get("archiveReason")))
    return jsonify({"ok": True}), 200


@pipeline_materials_bp.route("/<int:pm_id>/restore", methods=["POST"])
def restore_pipeline_material(pm_id):
    """Restore an archived pipeline material, upload new WAZ PDF, assign next sequential WAZ number, and regenerate package."""
    from app.models.project import Project
    from app.models.pipeline import Pipeline
    from app.sharepoint import upload_waz_to_project_folder, format_waz_filename

    m = PipelineMaterial.query.get_or_404(pm_id)
    pipeline = Pipeline.query.get_or_404(m.pipeline_id)
    if m.struck:
        return _struck_refusal()
    pm = m.project_material
    if not pm:
        return jsonify({"error": "No project material found"}), 400

    project = Project.query.get(pm.project_id)
    if not project:
        return jsonify({"error": "Project not found"}), 400

    file = request.files.get("file")
    file_content = None
    content_type = "application/pdf"
    if file and file.filename:
        file_content = file.read()
        content_type = file.content_type or "application/pdf"

    heat_no = clean_str(request.form.get("heatNo", "") or pm.heat_no)
    certificate = clean_str(request.form.get("certificate", "") or pm.certificate)
    existing_pdf_url = request.form.get("existingPdfUrl", "").strip()

    cur_heat = clean_str(pm.heat_no)
    cur_cert = clean_str(pm.certificate)

    if heat_no != cur_heat or certificate != cur_cert:
        existing_pm = find_matching_project_material(
            pm.project_id, pm.global_material_id, certificate, heat_no
        )
        if existing_pm:
            m.project_material_id = existing_pm.id
            pm = existing_pm
        else:
            new_pm = ProjectMaterial(
                project_id=pm.project_id,
                global_material_id=pm.global_material_id,
                certificate=certificate,
                heat_no=heat_no,
            )
            db.session.add(new_pm)
            db.session.flush()
            m.project_material_id = new_pm.id
            pm = new_pm
    else:
        pm.heat_no = heat_no
        pm.certificate = certificate

    if not pm.waz_pdf_url:
        if existing_pdf_url:
            pm.waz_pdf_url = existing_pdf_url
        elif heat_no:
            matched_pm = ProjectMaterial.query.filter(
                ProjectMaterial.heat_no == heat_no,
                ProjectMaterial.waz_pdf_url.isnot(None),
                ProjectMaterial.waz_pdf_url != "",
            ).first()
            if matched_pm:
                pm.waz_pdf_url = matched_pm.waz_pdf_url

    if file_content and project.sharepoint_drive_id and project.sharepoint_folder_id:
        gm = pm.global_material
        dims = _gm_dim_props(gm)
        proj_waz_name = format_waz_filename(
            item_desc=gm.item_description if gm else "",
            dn=gm.dn1 if gm else "",
            diameter=gm.diameter if gm else "",
            thickness=gm.thickness if gm else "",
            dns=dims["dns"],
            diameters=dims["diameters"],
            thicknesses=dims["thicknesses"],
            material_code=gm.material_code if gm else "",
            surface=gm.surface if gm else "",
            heat_no=pm.heat_no or "",
        )
        url = upload_waz_to_project_folder(
            project.sharepoint_drive_id,
            project.sharepoint_folder_id,
            proj_waz_name,
            file_content,
            content_type,
        )
        if url:
            pm.waz_pdf_url = url

    # Assign its position letter
    locked = _numbering_frozen(m.pipeline_id)
    if locked:
        m.archived = False
        _clear_archive_log(m)
        m.position = _next_free_letter(m.pipeline_id)
        m.sort_order = None
    else:
        db.session.flush()
        _restore_in_place(m)      # back to its old place, with its connections and welds

    # Assign next sequential WAZ number
    m.waz_no = _assign_waz_no(m.pipeline_id, m.project_material_id)
    db.session.commit()

    if file_content or (pm and pm.waz_pdf_url):
        _build_and_save_waz_package(m, file_content=file_content)

    if locked:
        _place_in_gap(m, m.pipeline_id)
    _renumber_positions(m.pipeline_id)
    _sync_pipeline_waz_nos(m.pipeline_id)

    db.session.commit()
    return jsonify(_serialize(m)), 200


@pipeline_materials_bp.route("/reorder", methods=["POST"])
def reorder_pipeline_materials():
    """Bulk update positions, connections, start/end flags after drag & drop."""
    data = request.get_json()
    pipeline_id = data["pipelineId"]
    items = data["materials"]

    # An empty list means there is nothing to reorder. Never treat it as "no material is
    # connected to anything", which would delete every weld in the pipeline.
    if not items:
        return jsonify({"status": "ok", "skipped": "no materials supplied"}), 200

    # Check the whole request before anything is changed. The positions end up in SQL and
    # in the weld list, so they must be plain letters; and every material must belong to
    # this pipeline - otherwise a bad or tampered request could relabel another pipeline.
    try:
        pipeline_id = int(pipeline_id)
        for item in items:
            item["id"] = int(item["id"])
            item["position"] = str(item.get("position") or "").strip().upper()
            if not re.fullmatch(r"[A-Z]{1,3}", item["position"]):
                raise ValueError(f"invalid position {item['position']!r}")
            if not isinstance(item.get("connections", []), list):
                raise ValueError("connections must be a list")
    except (TypeError, ValueError, KeyError) as e:
        return jsonify({"error": "invalid_request", "message": f"Reorder refused: {e}."}), 400
    if len({i["id"] for i in items}) != len(items) or len({i["position"] for i in items}) != len(items):
        return jsonify({"error": "invalid_request",
                        "message": "Reorder refused: a material or a position letter appears twice."}), 400
    own_ids = {r.id for r in db.session.execute(db.text("""
        SELECT id FROM weldoc_pipeline_materials WHERE pipeline_id = :pid AND archived = 0
    """), {"pid": pipeline_id}).fetchall()}
    foreign = sorted(i["id"] for i in items if i["id"] not in own_ids)
    if foreign:
        return jsonify({"error": "invalid_request",
                        "message": f"Reorder refused: material(s) {foreign} are not active materials of this pipeline."}), 400

    # Once a welder or inspector is on a weld, the running order is fixed. Reordering
    # rewrites which materials every weld joins, so it is refused here as well as being
    # disabled in the UI - this endpoint can still be reached from a stale browser tab.
    if _numbering_frozen(pipeline_id):
        return jsonify({
            "error": "reorder_locked",
            "message": "Materials cannot be reordered: a welder or inspector is already "
                       "assigned to a weld in this pipeline.",
        }), 409

    # 0. Welds reference position letters, and this request is about to change what those
    #    letters mean. Resolve every existing weld to a pair of MATERIAL IDS first: that is
    #    the only identity a weld has that survives a reorder. Without this snapshot the
    #    welds cannot be matched afterwards and the welder, inspector, date, wire and
    #    results recorded on them would have to be thrown away.
    _ensure_weld_ids(pipeline_id)     # welds not matched yet: match them while the letters still hold
    old_pos_rows = db.session.execute(db.text("""
        SELECT id, position FROM weldoc_pipeline_materials
        WHERE pipeline_id = :pid AND archived = 0
    """), {"pid": pipeline_id}).fetchall()
    old_pos_to_id = {r.position: r.id for r in old_pos_rows if r.position}

    existing_welds = db.session.execute(db.text("""
        SELECT id, between_a, between_b, material_a_id, material_b_id, type, welding_wire,
               welder_id, inspector_id, date, visual, endoscopy, remarks
        FROM weldoc_welds
        WHERE pipeline_id = :pid AND archived = 0
    """), {"pid": pipeline_id}).fetchall()

    def _recorded(w):
        """How much real work is recorded on a weld - used only to pick which of two
        duplicates for the same pair to keep."""
        return sum(
            1 for v in (w.welder_id, w.inspector_id, w.date, w.type,
                        w.welding_wire, w.remarks)
            if v not in (None, "")
        ) + sum(1 for v in (w.visual, w.endoscopy) if v not in (None, "", "n/a"))

    weld_by_pair = {}     # (id_a, id_b) -> the weld row to keep
    stale_weld_ids = []   # welds that no longer correspond to anything
    for w in existing_welds:
        # A weld's materials: its ids, or - not matched yet - what its letters point at now
        if w.material_a_id and w.material_b_id:
            a, b = w.material_a_id, w.material_b_id
        else:
            a = old_pos_to_id.get(w.between_a)
            b = old_pos_to_id.get(w.between_b)
        if not a or not b or a == b:
            stale_weld_ids.append(w.id)     # dangling: an end no longer exists
            continue
        key = (a, b) if a < b else (b, a)
        kept = weld_by_pair.get(key)
        if kept is None:
            weld_by_pair[key] = w
        elif _recorded(w) > _recorded(kept):
            weld_by_pair[key] = w           # duplicate pair: keep the one with data
            stale_weld_ids.append(kept.id)
        else:
            stale_weld_ids.append(w.id)

    # 1. Update all positions/flags. The values travel as parameters, never as part of the
    #    SQL text, so whatever a request contains can only ever be stored as a value.
    db.session.execute(db.text("""
        UPDATE weldoc_pipeline_materials
        SET position = :pos, start_of_plumbing = :sop, end_of_plumbing = :eop
        WHERE id = :id AND pipeline_id = :pid
    """), [{
        "id": i["id"], "pid": pipeline_id, "pos": i["position"],
        "sop": 1 if i.get("startOfPlumbing") else 0,
        "eop": 1 if i.get("endOfPlumbing") else 0,
    } for i in items])

    # 2. Clear all connections for this pipeline's materials
    mat_ids = [item["id"] for item in items]
    if mat_ids:
        placeholders = ",".join(str(int(mid)) for mid in mat_ids)
        db.session.execute(db.text(f"""
            DELETE FROM weldoc_pipeline_material_connections
            WHERE pipeline_material_id IN ({placeholders})
               OR connected_id IN ({placeholders})
        """))

    # 3. Rebuild connections; welds are reconciled against the snapshot further down
    pos_to_id = {item["position"]: item["id"] for item in items}
    seen_conn = set()
    seen_weld = set()
    conn_inserts = []
    desired_welds = []    # [((id_a, id_b), (letter_a, letter_b))] in no particular order

    # Get wire IDs for this pipeline to prevent wire connections
    wire_rows = db.session.execute(db.text("""
        SELECT pm.id FROM weldoc_pipeline_materials pm
        JOIN weldoc_project_materials prm ON pm.project_material_id = prm.id
        JOIN weldoc_global_materials gm ON prm.global_material_id = gm.id
        WHERE pm.pipeline_id = :pid AND LOWER(RTRIM(LTRIM(COALESCE(gm.category, '')))) = 'welding wire'
    """), {"pid": pipeline_id}).fetchall()
    wire_id_set = {r.id for r in wire_rows}

    for item in items:
        if item["id"] in wire_id_set:
            continue
        for conn_pos in item.get("connections", []):
            conn_id = pos_to_id.get(conn_pos)
            if not conn_id or conn_id == item["id"] or conn_id in wire_id_set:
                continue
            # Bidirectional connections — track both directions
            pair_conn = tuple(sorted([item["id"], conn_id]))
            if pair_conn not in seen_conn:
                seen_conn.add(pair_conn)
                conn_inserts.append({"a": pair_conn[0], "b": pair_conn[1]})
                conn_inserts.append({"a": pair_conn[1], "b": pair_conn[0]})

            # One weld per unique pair of materials
            if pair_conn not in seen_weld:
                seen_weld.add(pair_conn)
                letters = tuple(sorted([item["position"], conn_pos], key=_letter_to_pos))
                desired_welds.append((pair_conn, letters))

    if conn_inserts:
        conn_values = ",".join(f"({int(c['a'])},{int(c['b'])})" for c in conn_inserts)
        db.session.execute(db.text(f"""
            INSERT INTO weldoc_pipeline_material_connections (pipeline_material_id, connected_id)
            VALUES {conn_values}
        """))

    # 4. Reconcile welds against the snapshot: keep every weld whose two materials are
    #    still joined (only its letters and number are rewritten), delete only the welds
    #    whose pair is really gone, and insert only pairs that had no weld before.
    desired_keys = {key for key, _ in desired_welds}
    for key, w in weld_by_pair.items():
        if key not in desired_keys:
            stale_weld_ids.append(w.id)

    if stale_weld_ids:
        id_csv = ",".join(str(int(i)) for i in sorted(set(stale_weld_ids)))
        db.session.execute(db.text(f"""
            DELETE FROM weldoc_welds WHERE id IN ({id_csv})
        """))

    desired_welds.sort(key=lambda d: (_letter_to_pos(d[1][0]), _letter_to_pos(d[1][1])))
    weld_updates = []
    weld_inserts = []
    for idx, (key, letters) in enumerate(desired_welds, 1):
        kept = weld_by_pair.get(key)
        ids = {"ma": pos_to_id[letters[0]], "mb": pos_to_id[letters[1]]}
        if kept is not None:
            weld_updates.append({
                "id": kept.id, "wno": str(idx), "ba": letters[0], "bb": letters[1], **ids,
            })
        else:
            weld_inserts.append({
                "pid": pipeline_id, "wno": str(idx), "ba": letters[0], "bb": letters[1], **ids,
            })

    if weld_updates:
        db.session.execute(db.text("""
            UPDATE weldoc_welds
            SET weld_no = :wno, between_a = :ba, between_b = :bb,
                material_a_id = :ma, material_b_id = :mb
            WHERE id = :id
        """), weld_updates)

    if weld_inserts:
        db.session.execute(db.text("""
            INSERT INTO weldoc_welds (pipeline_id, weld_no, between_a, between_b, material_a_id, material_b_id, archived)
            VALUES (:pid, :wno, :ba, :bb, :ma, :mb, 0)
        """), weld_inserts)

    db.session.commit()
    _sync_sort_order(pipeline_id)
    _sync_pipeline_waz_nos(pipeline_id)
    return jsonify({"status": "ok"}), 200


def _archive_pipeline_material(m, reason=None):
    """Perform archive actions for a pipeline material:
    1. Bridge connections if exactly 2 active neighbors.
    2. Clear connections; its welds are archived WITH it (same archived_at), not deleted.
    3. Renumber positions. Its place (sort_order) is kept, so a restore puts it back there.
    4. Delete WAZ file from SharePoint if unique to this material, clear waz_no, and resequence remaining active WAZ numbers.

    For a pipeline nobody has welded on yet. Once someone has, see _strike_pipeline_material.
    Undone by _restore_in_place.
    """
    now = datetime.utcnow()
    m.archived = True
    _log_archive(m, reason, at=now)
    active_conns = [c for c in m.connections if not c.archived]
    if len(active_conns) == 2:
        cA, cB = active_conns[0], active_conns[1]
        if cB not in cA.connections:
            cA.connections.append(cB)
        if cA not in cB.connections:
            cB.connections.append(cA)

    m.connections = []

    pos = m.position
    pipeline_id = m.pipeline_id
    _ensure_weld_ids(pipeline_id)
    for w in _welds_on_material(pipeline_id, m.id, pos):
        # Archived together with the material - the same archived_at links them - so a
        # restore brings them back with everything recorded on them.
        w.archived = True
        _log_archive(w, None, at=now)

    # Release the position letter. An archived material that keeps its letter collides with
    # whichever active material is relabelled onto it, and that duplicate then corrupts the
    # next renumber - welds get rewired to the wrong materials. Its PLACE is kept in
    # sort_order, which is what a restore uses.
    m.position = None

    db.session.commit()

    # `m.connections = []` above only owns the rows where pipeline_material_id = m.id.
    # The mirrored rows (neighbour -> m) survive it, and they re-link this material to its
    # old neighbours the moment it is restored - at their new letters, so it comes back
    # wired to the wrong materials. Remove both directions.
    db.session.execute(db.text("""
        DELETE FROM weldoc_pipeline_material_connections
        WHERE pipeline_material_id = :mid OR connected_id = :mid
    """), {"mid": m.id})
    db.session.commit()
    db.session.expire_all()

    _renumber_positions(pipeline_id)

    if m.waz_no:
        old_waz = m.waz_no.strip().upper()
        old_pkg_url = m.waz_package_url
        m.waz_no = None
        m.waz_package_url = None
        db.session.commit()

        other_active = PipelineMaterial.query.filter_by(
            pipeline_id=pipeline_id, archived=False
        ).filter(PipelineMaterial.waz_no == old_waz).count()

        if other_active == 0:
            _delete_pipeline_waz_file_for_material(m, old_waz, old_pkg_url)
            _resequence_pipeline_waz_numbers_and_regenerate(pipeline_id)


def _delete_pipeline_waz_file_for_material(m, waz_no, waz_pkg_url=None):
    """Delete the WAZ PDF for this material from the pipeline WAZ folder on SharePoint."""
    from app.models.project import Project
    from app.models.pipeline import Pipeline
    from app.sharepoint import format_waz_filename, delete_pipeline_waz_file

    try:
        pipeline = Pipeline.query.get(m.pipeline_id)
        pm = m.project_material
        if pipeline and pm:
            project = Project.query.get(pm.project_id)
            if project and project.sharepoint_drive_id and project.sharepoint_folder_id:
                gm = pm.global_material
                dims = _gm_dim_props(gm)
                pkg_name = format_waz_filename(
                    item_desc=gm.item_description if gm else "",
                    dn=gm.dn1 if gm else "",
                    diameter=gm.diameter if gm else "",
                    thickness=gm.thickness if gm else "",
                    dns=dims["dns"],
                    diameters=dims["diameters"],
                    thicknesses=dims["thicknesses"],
                    material_code=gm.material_code if gm else "",
                    surface=gm.surface if gm else "",
                    heat_no=pm.heat_no or "",
                    waz_no=waz_no,
                )
                delete_pipeline_waz_file(
                    project.sharepoint_drive_id,
                    project.sharepoint_folder_id,
                    pipeline.no,
                    pkg_name
                )
    except Exception as e:
        from flask import current_app
        current_app.logger.error(f"Error deleting WAZ file for material: {e}")


def _resequence_pipeline_waz_numbers_and_regenerate(pipeline_id, force_regenerate_all=False):
    """Resequence all active WAZ numbers in the pipeline to be strictly consecutive (Z001, Z002, Z003...),
    delete old SharePoint files for changed WAZ numbers, regenerate updated WAZ packages with new cover sheets,
    clean obsolete files from SharePoint, and update database records."""
    import re
    from app.models.pipeline import Pipeline
    from app.models.project import Project
    from app.sharepoint import format_waz_filename, delete_pipeline_waz_file, delete_sharepoint_file_by_url, clean_pipeline_waz_folder

    pipeline = Pipeline.query.get(pipeline_id)
    if not pipeline:
        return 0, 0

    active_mats = PipelineMaterial.query.filter_by(
        pipeline_id=pipeline_id, archived=False
    ).order_by(PipelineMaterial.position, PipelineMaterial.id).all()

    material_groups = []
    seen_groups = {}

    for m in active_mats:
        pm = m.project_material
        if not pm or not pm.certificate or not (pm.heat_no or "").strip():
            if m.waz_no:
                m.waz_no = None
                m.waz_package_url = None
            continue

        c_key = (pm.certificate or "").strip().lower()
        h_key = (pm.heat_no or "").strip().lower()
        grp_key = (pm.global_material_id, c_key, h_key)
        if grp_key not in seen_groups:
            group = {
                "grp_key": grp_key,
                "old_waz": m.waz_no,
                "mats": [m]
            }
            seen_groups[grp_key] = group
            material_groups.append(group)
        else:
            seen_groups[grp_key]["mats"].append(m)

    def _waz_sort_key(grp):
        old_w = grp["old_waz"]
        if old_w:
            match = re.match(r'^Z(\d+)$', old_w.strip(), re.IGNORECASE)
            if match:
                return (0, int(match.group(1)))
        return (1, grp["mats"][0].id)

    material_groups.sort(key=_waz_sort_key)

    regen_count = 0
    valid_filenames = set()

    for idx, grp in enumerate(material_groups, 1):
        target_waz = f"Z{idx:03d}"
        old_waz = grp["old_waz"]
        waz_changed = (old_waz != target_waz)

        primary_m = grp["mats"][0]
        pm = primary_m.project_material
        gm = pm.global_material if pm else None
        project = Project.query.get(pm.project_id) if pm else None
        dims = _gm_dim_props(gm)

        # Build target filename
        target_fname = format_waz_filename(
            item_desc=gm.item_description if gm else "",
            dn=gm.dn1 if gm else "",
            diameter=gm.diameter if gm else "",
            thickness=gm.thickness if gm else "",
            dns=dims["dns"],
            diameters=dims["diameters"],
            thicknesses=dims["thicknesses"],
            material_code=gm.material_code if gm else "",
            surface=gm.surface if gm else "",
            heat_no=pm.heat_no or "",
            waz_no=target_waz,
        )
        valid_filenames.add(target_fname)

        if waz_changed and old_waz:
            if project and project.sharepoint_drive_id and project.sharepoint_folder_id:
                old_pkg_name = format_waz_filename(
                    item_desc=gm.item_description if gm else "",
                    dn=gm.dn1 if gm else "",
                    diameter=gm.diameter if gm else "",
                    thickness=gm.thickness if gm else "",
                    dns=dims["dns"],
                    diameters=dims["diameters"],
                    thicknesses=dims["thicknesses"],
                    material_code=gm.material_code if gm else "",
                    surface=gm.surface if gm else "",
                    heat_no=pm.heat_no or "",
                    waz_no=old_waz,
                )
                delete_pipeline_waz_file(
                    project.sharepoint_drive_id,
                    project.sharepoint_folder_id,
                    pipeline.no,
                    old_pkg_name
                )

        for m in grp["mats"]:
            m.waz_no = target_waz
        db.session.commit()

        if force_regenerate_all or waz_changed or not primary_m.waz_package_url:
            pkg_url, _ = _build_and_save_waz_package_with_bytes(primary_m, file_content=None)
            if pkg_url:
                regen_count += 1
                for m in grp["mats"]:
                    m.waz_package_url = pkg_url
                db.session.commit()

    # Clean obsolete / duplicate files in SharePoint folder
    deleted_old = 0
    project = Project.query.get(pipeline.project_id)
    if project and project.sharepoint_drive_id and project.sharepoint_folder_id:
        deleted_old = clean_pipeline_waz_folder(
            project.sharepoint_drive_id,
            project.sharepoint_folder_id,
            pipeline.no,
            keep_filenames=valid_filenames
        )

    db.session.commit()
    return regen_count, deleted_old


def _assign_waz_no(pipeline_id, project_material_id):
    """Auto-assign WAZ number only if project material has certificate + heat number.
    Same project material (or same global_material_id + cert + heat) in same pipeline = same WAZ no.
    Different materials / heats = unique sequential WAZ numbers (Z001, Z002, etc.)."""
    import re
    pm = ProjectMaterial.query.get(project_material_id)
    if not pm or not pm.certificate or not (pm.heat_no or "").strip():
        return None  # Don't assign WAZ number yet

    c_target = pm.certificate.strip().lower()
    h_target = pm.heat_no.strip().lower()
    gm_target = pm.global_material_id

    # Query all active pipeline materials in this pipeline
    existing_mats = PipelineMaterial.query.filter_by(
        pipeline_id=pipeline_id, archived=False
    ).all()

    # Check if any existing material in this pipeline has the same project material spec and an assigned waz_no
    for mat in existing_mats:
        if mat.project_material:
            m_pm = mat.project_material
            if (m_pm.global_material_id == gm_target and
                (m_pm.certificate or "").strip().lower() == c_target and
                (m_pm.heat_no or "").strip().lower() == h_target and
                mat.waz_no):
                return mat.waz_no

    # If new material spec / heat number in the pipeline, find max existing Z number to avoid any collisions
    used_nums = []
    for mat in existing_mats:
        if mat.waz_no:
            match = re.match(r'^Z(\d+)$', mat.waz_no.strip(), re.IGNORECASE)
            if match:
                used_nums.append(int(match.group(1)))

    next_num = max(used_nums, default=0) + 1
    return f"Z{next_num:03d}"


def _sync_pipeline_waz_nos(pipeline_id):
    """Ensure 1 unique project material spec = 1 WAZ number per pipeline, eliminate duplicate Z numbers across different specs,
    and propagate waz_package_url across matching project materials."""
    import re
    mats = PipelineMaterial.query.filter_by(
        pipeline_id=pipeline_id, archived=False
    ).order_by(PipelineMaterial.position, PipelineMaterial.id).all()

    def _pm_key(pm):
        if not pm or not pm.certificate or not (pm.heat_no or "").strip():
            return None
        c = (pm.certificate or "").strip().lower()
        h = (pm.heat_no or "").strip().lower()
        return (pm.global_material_id, c, h)

    pm_to_waz = {}
    waz_to_pm = {}
    pm_to_pkg = {}
    used_nums = set()

    # First pass: collect existing unambiguous assignments & package URLs
    for m in mats:
        pm = m.project_material
        k = _pm_key(pm)
        if not k:
            continue

        if m.waz_package_url and k not in pm_to_pkg:
            pm_to_pkg[k] = m.waz_package_url

        if m.waz_no:
            waz = m.waz_no.strip().upper()
            match = re.match(r'^Z(\d+)$', waz)
            if match:
                num = int(match.group(1))
                if waz not in waz_to_pm and k not in pm_to_waz:
                    pm_to_waz[k] = waz
                    waz_to_pm[waz] = k
                    used_nums.add(num)

    # Second pass: assign canonical WAZ number and propagate package URL to all matching rows
    changed = False
    next_num = 1
    for m in mats:
        pm = m.project_material
        k = _pm_key(pm)
        if not k:
            if m.waz_no is not None:
                m.waz_no = None
                changed = True
            continue

        if k not in pm_to_waz:
            while next_num in used_nums:
                next_num += 1
            assigned_waz = f"Z{next_num:03d}"
            used_nums.add(next_num)
            pm_to_waz[k] = assigned_waz
            waz_to_pm[assigned_waz] = k

        canonical_waz = pm_to_waz[k]
        if m.waz_no != canonical_waz:
            m.waz_no = canonical_waz
            changed = True

        if k in pm_to_pkg and m.waz_package_url != pm_to_pkg[k]:
            m.waz_package_url = pm_to_pkg[k]
            changed = True

    if changed:
        db.session.commit()


def _waz_fingerprint(m):
    """Everything that is printed on the WAZ cover page or baked into its filename.

    Used to tell whether an already generated package still matches the material.
    """
    pm = m.project_material
    gm = pm.global_material if pm else None
    if not gm:
        return None
    return (
        (gm.item_description or "").strip().lower(),
        (gm.dien_no or "").strip().lower(),
        tuple((getattr(gm, f"dn{i}") or "").strip().lower() for i in range(1, 7)),
        tuple((d or "").strip().lower() for d in [gm.diameter, gm.diameter2, gm.diameter3]),
        tuple((t or "").strip().lower() for t in [gm.thickness, gm.thickness2, gm.thickness3]),
        (gm.material_code or "").strip().lower(),
        (gm.surface or "").strip().lower(),
        (pm.heat_no or "").strip().lower(),
        (m.waz_no or "").strip().upper(),
    )


def _delete_unreferenced_waz_packages(urls):
    """Delete WAZ package files that no active material points at any more.

    Only ever called with URLs this app recorded itself, and each one is re-checked against
    the database first - so a file that is still in use is never removed, and files the app
    did not create are never even considered.
    """
    urls = {u for u in (urls or []) if u}
    if not urls:
        return
    still_used = {
        u for (u,) in db.session.query(PipelineMaterial.waz_package_url)
        .filter(PipelineMaterial.waz_package_url.in_(list(urls)))
        .filter(PipelineMaterial.archived == False)
        .all() if u
    }
    from app.sharepoint import delete_sharepoint_file_by_url
    for url in urls - still_used:
        try:
            delete_sharepoint_file_by_url(url)
        except Exception as e:
            from flask import current_app
            current_app.logger.error(f"Could not delete unreferenced WAZ package {url}: {e}")


def _regenerate_waz_package(pipeline_material_id, user_name=None):
    """Rebuild the WAZ package for a material after its details changed.

    The cover page carries the item description, DN(s), diameter(s), thickness(es), surface,
    heat number and WAZ number, and the filename encodes them too - so once any of those is
    edited the stored package is stale. The raw PDF is re-downloaded from the project folder,
    a fresh cover is merged onto it, and the new package is shared with every material in the
    pipeline that has the same spec. Only the single superseded file is deleted afterwards.
    """
    m = PipelineMaterial.query.get(pipeline_material_id)
    if not m or m.archived:
        return
    pm = m.project_material
    if not pm or not pm.waz_pdf_url or not m.waz_no:
        return

    # Remember the package files currently in use so the stale one can be removed afterwards
    c_norm = (pm.certificate or "").strip().lower()
    h_norm = (pm.heat_no or "").strip().lower()
    siblings = PipelineMaterial.query.filter_by(
        pipeline_id=m.pipeline_id, archived=False
    ).filter(PipelineMaterial.id != m.id).all()
    same_spec = [
        sib for sib in siblings
        if sib.project_material
        and sib.project_material.global_material_id == pm.global_material_id
        and (sib.project_material.certificate or "").strip().lower() == c_norm
        and (sib.project_material.heat_no or "").strip().lower() == h_norm
    ]
    old_pkg_urls = {u for u in [m.waz_package_url] + [sib.waz_package_url for sib in same_spec] if u}

    pkg_url, _ = _build_and_save_waz_package_with_bytes(m, file_content=None, user_name=user_name)
    if not pkg_url:
        return

    # Share the rebuilt package with the other materials carrying the same spec
    for sib in same_spec:
        sib.waz_no = m.waz_no
        sib.waz_package_url = pkg_url
    db.session.commit()

    # Delete ONLY the superseded package file. Never sweep the folder: it also holds documents
    # this app did not create, and deleting by "everything that does not match" would take them.
    _delete_unreferenced_waz_packages(old_pkg_urls - {pkg_url})


def _build_and_save_waz_package_with_bytes(m, file_content=None, user_name=None):
    """Generate Cover Letter, merge with raw WAZ PDF, upload combined package to SharePoint, and save waz_package_url.
    Returns (pkg_url, merged_pdf_bytes)."""
    from app.models.project import Project
    from app.models.pipeline import Pipeline
    from app.models.client import Client
    from app.sharepoint import upload_to_pipeline_waz_folder, _get_app_token, _ssl_context, GRAPH_BASE
    from app.waz_cover import generate_waz_cover_page
    from pypdf import PdfWriter, PdfReader
    from datetime import date
    import base64
    import urllib.request
    import io

    pm = m.project_material
    if not pm or not pm.waz_pdf_url:
        return None, None

    pipeline = Pipeline.query.get(m.pipeline_id)
    project = Project.query.get(pm.project_id)
    if not project or not pipeline:
        return None, None

    if file_content is None:
        # Download from SharePoint
        try:
            token = _get_app_token()
            encoded_url = base64.urlsafe_b64encode(pm.waz_pdf_url.encode()).decode().rstrip("=")
            share_id = "u!" + encoded_url
            download_url = f"{GRAPH_BASE}/shares/{share_id}/driveItem/content"
            req = urllib.request.Request(download_url)
            req.add_header("Authorization", f"Bearer {token}")
            with urllib.request.urlopen(req, context=_ssl_context()) as resp:
                file_content = resp.read()
        except Exception as e:
            from flask import current_app
            current_app.logger.error(f"Could not download raw WAZ PDF: {e}")
            return None, None

    if not file_content:
        return None, None

    # 1. Generate Cover Letter
    client = Client.query.get(project.client_id)
    gm = pm.global_material
    from flask import session as flask_session
    from app.dates import today_str
    # Outside a request - a background rebuild - the session is unavailable and reads as empty,
    # which is why "Erstellt von" came out blank. Callers running in a request pass the name in.
    if user_name is None:
        user_name = flask_session.get("user", {}).get("name", "") if flask_session else ""

    cover_data = {
        "user_name": user_name,
        "date": today_str(),
        "client_name": client.name if client else "",
        "client_street": client.street or "" if client else "",
        "client_zip": client.zip_code or "" if client else "",
        "client_place": client.location or "" if client else "",
        "order_no": project.order_no or "",
        "project_title": project.title or "",
        "location_zip": "",
        "location_place": project.location or "",
        "project_no_ist": project.ist_project_no or "",
        "pipeline_no": pipeline.no,
        "waz_no": m.waz_no or "",
        "item_description": gm.item_description or "" if gm else "",
        "norm": gm.dien_no or "" if gm else "",
        "dn": gm.dn1 or "" if gm else "",
        "dns": [getattr(gm, f"dn{i}") for i in range(1, 7) if getattr(gm, f"dn{i}")] if gm else [],
        "diameter": gm.diameter or "" if gm else "",
        "diameters": [d for d in [gm.diameter, gm.diameter2, gm.diameter3] if d] if gm else [],
        "thickness": gm.thickness or "" if gm else "",
        "thicknesses": [t for t in [gm.thickness, gm.thickness2, gm.thickness3] if t] if gm else [],
        "surface": gm.surface or "" if gm else "",
        "heat_no": pm.heat_no or "",
    }
    cover_pdf = generate_waz_cover_page(cover_data)

    # 2. Merge Cover Letter (Page 1) + WAZ Document (Page 2+)
    writer = PdfWriter()
    try:
        cover_reader = PdfReader(io.BytesIO(cover_pdf))
        for page in cover_reader.pages:
            writer.add_page(page)
    except Exception as e:
        from flask import current_app
        current_app.logger.error(f"Failed to read cover PDF: {e}")

    try:
        waz_reader = PdfReader(io.BytesIO(file_content))
        for page in waz_reader.pages:
            writer.add_page(page)
    except Exception as e:
        from flask import current_app
        current_app.logger.error(f"Failed to read raw WAZ PDF: {e}")

    out_buf = io.BytesIO()
    writer.write(out_buf)
    merged_pdf_bytes = out_buf.getvalue()

    # 3. Upload combined package to SharePoint
    pkg_url = None
    if project.sharepoint_drive_id and project.sharepoint_folder_id:
        from app.sharepoint import format_waz_filename
        dims_dns = [getattr(gm, f"dn{i}") for i in range(1, 7) if getattr(gm, f"dn{i}")] if gm else []
        dims_dias = [d for d in [gm.diameter, gm.diameter2, gm.diameter3] if d] if gm else []
        dims_thks = [t for t in [gm.thickness, gm.thickness2, gm.thickness3] if t] if gm else []
        pkg_name = format_waz_filename(
            item_desc=gm.item_description if gm else "",
            dn=gm.dn1 if gm else "",
            diameter=gm.diameter if gm else "",
            thickness=gm.thickness if gm else "",
            dns=dims_dns,
            diameters=dims_dias,
            thicknesses=dims_thks,
            material_code=gm.material_code if gm else "",
            surface=gm.surface if gm else "",
            heat_no=pm.heat_no or "",
            waz_no=m.waz_no or "WAZ",
        )
        pkg_url = upload_to_pipeline_waz_folder(
            project.sharepoint_drive_id, project.sharepoint_folder_id,
            pipeline.no, pkg_name, merged_pdf_bytes, "application/pdf"
        )
        if pkg_url:
            m.waz_package_url = pkg_url
            db.session.commit()

    return pkg_url, merged_pdf_bytes


def _build_and_save_waz_package(m, file_content=None, user_name=None):
    pkg_url, _ = _build_and_save_waz_package_with_bytes(m, file_content, user_name=user_name)
    return pkg_url


def _copy_waz_to_pipeline_folder(m):
    return _build_and_save_waz_package(m)


# --- Welds that an action would delete ------------------------------------------------------
# Archiving a material, removing a connection and the "inserted between" rule all delete
# welds as a side effect. A weld with recorded work (welder, inspector, date, results,
# remarks, photo, video) must never disappear without the user seeing it: the action is
# first answered with 409 "confirm_weld_deletion" and the list of those welds, and only runs
# once the request comes back with their ids in "confirmDeleteWelds". The list is worked out
# again on every request, so a weld that got work in the meantime is asked about again.

# --- Archiving after welding (migration 011) -------------------------------------------------
# Once a welder or inspector is on a weld of a pipeline (_numbering_frozen), its letters, weld
# numbers and connections are part of the record. Archiving a material then "strikes" it: the
# material and its welds stay in the lists, struck through, with who, when and why - nothing
# is deleted, no letter changes, and no weld is created in their place. The gap is closed by
# the user: connect the two neighbours, or add a new material between them (new weld numbers).

def _actor():
    from flask import session
    user = session.get("user") or {}
    return (user.get("name") or user.get("email") or "")[:255]


def _log_archive(row, reason=None, at=None):
    row.archived_at = at or datetime.utcnow()
    row.archived_by = _actor()
    row.archive_reason = (reason or None) and reason[:1000]


def _clear_archive_log(row):
    row.archived_at = None
    row.archived_by = None
    row.archive_reason = None
    row.struck = False


def _reason_required(m):
    welds = sorted(_welds_on_material(m.pipeline_id, m.id, m.position),
                   key=lambda w: (_weld_no_int(w.weld_no) or 0, w.id))
    return jsonify({
        "error": "archive_reason_required",
        "message": "A welder or inspector is assigned in this pipeline: the material and its "
                   "welds are struck through, not deleted. Please enter the reason.",
        "position": m.position,
        "weldNos": [w.weld_no for w in welds],
    }), 409


def _struck_refusal():
    return jsonify({
        "error": "struck_cannot_restore",
        "message": "This was archived after welding and is part of the record. It cannot be "
                   "restored - add a new material instead.",
    }), 409


def _strike_pipeline_material(m, reason):
    """Archive a material of a pipeline that has been welded on: it and its welds are struck
    through and stay in the lists. Its letter and its welds' numbers are kept (never reused),
    no weld is deleted and none is created between its neighbours."""
    pipeline_id = m.pipeline_id
    _ensure_weld_ids(pipeline_id)
    for w in _welds_on_material(pipeline_id, m.id, m.position):
        w.archived = True
        _log_archive(w, reason)
        w.struck = True
    m.archived = True
    _log_archive(m, reason)
    m.struck = True
    db.session.commit()

    # Its connections go - the struck welds are the history of what it was joined to. Both
    # directions, see _archive_pipeline_material.
    db.session.execute(db.text("""
        DELETE FROM weldoc_pipeline_material_connections
        WHERE pipeline_material_id = :mid OR connected_id = :mid
    """), {"mid": m.id})
    db.session.commit()
    db.session.expire_all()

    if m.waz_no:
        old_waz = m.waz_no.strip().upper()
        old_pkg_url = m.waz_package_url
        m.waz_no = None
        m.waz_package_url = None
        db.session.commit()
        other_active = PipelineMaterial.query.filter_by(
            pipeline_id=pipeline_id, archived=False
        ).filter(PipelineMaterial.waz_no == old_waz).count()
        if other_active == 0:
            # Its number is simply freed. The others are NOT renumbered: that would change
            # their cover pages and file names and force every package to be rebuilt. A new
            # material gets a new number (_assign_waz_no).
            _delete_pipeline_waz_file_for_material(m, old_waz, old_pkg_url)


def _strike_weld(w, reason):
    """Archive one weld of a pipeline that has been welded on: struck through, number kept
    (never reused). Its two materials stay connected - connections are fixed after welding -
    so the joint gets a new weld with the next free number."""
    w.archived = True
    _log_archive(w, reason)
    w.struck = True
    db.session.commit()
    _sync_and_renumber_welds(w.pipeline_id)


def _restore_in_place(m):
    """Restore a material archived before welding to the place it had: the same letter (the
    others shift back), its connections and the welds archived with it, and the bridge weld
    between its two neighbours removed again. Welds are renumbered along the pipe. A material
    archived before this existed (no place kept, welds deleted back then) goes to the end.

    Must run while m still carries its archive log (archived_at identifies its welds)."""
    pipeline_id = m.pipeline_id
    archived_at = m.archived_at
    welds = []
    if archived_at is not None:
        welds = Weld.query.filter(
            Weld.pipeline_id == pipeline_id, Weld.archived == True, Weld.struck == False,  # noqa: E712
            db.or_(Weld.material_a_id == m.id, Weld.material_b_id == m.id),
            Weld.archived_at == archived_at,
        ).all()

    active = PipelineMaterial.query.filter_by(pipeline_id=pipeline_id, archived=False).filter(
        PipelineMaterial.id != m.id).all()
    active.sort(key=lambda r: (_letter_to_pos(r.position) if r.position else 10 ** 9, r.id))
    idx = len(active)
    if m.sort_order is not None:
        idx = max(0, min(m.sort_order - 1, len(active)))
    order = active[:idx] + [m] + active[idx:]

    _ensure_weld_ids(pipeline_id)
    m.archived = False
    _clear_archive_log(m)
    for i, r in enumerate(order, 1):
        r.position = _pos_letter(i)
        r.sort_order = i
    db.session.commit()

    # Its connections and welds, to the materials that are still there
    neighbours = []
    for w in welds:
        other_id = w.material_b_id if w.material_a_id == m.id else w.material_a_id
        other = PipelineMaterial.query.get(other_id)
        if not other or other.archived or other.pipeline_id != pipeline_id:
            continue            # that side is gone: the weld stays archived
        if other not in m.connections:
            m.connections.append(other)
        if m not in other.connections:
            other.connections.append(m)
        w.archived = False
        _clear_archive_log(w)
        neighbours.append(other)
    db.session.commit()

    # The bridge made on archive: its two neighbours joined to each other. The material sits
    # between them again, so that link and its weld go - unless something was recorded on it.
    if len(neighbours) == 2:
        a, b = neighbours
        if b in a.connections:
            bridge = _welds_on_joint(pipeline_id, a.id, a.position, b.id, b.position)
            if not any(_weld_work(w) for w in bridge):
                a.connections.remove(b)
                if a in b.connections:
                    b.connections.remove(a)
                for w in bridge:
                    db.session.delete(w)
                db.session.commit()

    _refresh_weld_labels(pipeline_id)
    db.session.commit()
    _sync_and_renumber_welds(pipeline_id)


def _lettered_materials(pipeline_id):
    """The materials that hold a letter: the active ones and the struck-through ones."""
    return PipelineMaterial.query.filter(
        PipelineMaterial.pipeline_id == pipeline_id,
        db.or_(PipelineMaterial.archived == False, PipelineMaterial.struck == True),  # noqa: E712
    ).all()


def _next_free_letter(pipeline_id):
    used = [_letter_to_pos(r.position) for r in _lettered_materials(pipeline_id) if r.position]
    return _pos_letter(max(used, default=0) + 1)


def _list_order(pipeline_id):
    """Active and struck materials in list order: sort_order, then letter."""
    rows = _lettered_materials(pipeline_id)
    big = 10 ** 9
    rows.sort(key=lambda r: (r.sort_order if r.sort_order is not None else big,
                             _letter_to_pos(r.position) if r.position else big, r.id))
    return rows


def _sync_sort_order(pipeline_id):
    """Before anyone has welded, the list simply follows the letters."""
    if _numbering_frozen(pipeline_id):
        return
    mats = PipelineMaterial.query.filter_by(pipeline_id=pipeline_id, archived=False).all()
    mats.sort(key=lambda r: (_letter_to_pos(r.position) if r.position else 10 ** 9, r.id))
    for i, r in enumerate(mats, 1):
        if r.sort_order != i:
            r.sort_order = i
    db.session.commit()


def _place_in_gap(m, pipeline_id):
    """After welding: put m in the list where it sits in the pipe. Joined to two or more
    parts, it goes right after the first of them - past any struck-through materials there,
    so a replacement reads directly below the one it replaces. Otherwise at the end."""
    rows = [r for r in _list_order(pipeline_id) if r.id != m.id]
    conns = [c for c in m.connections if not c.archived and c.id != m.id]
    idx = len(rows)
    if len(conns) >= 2:
        ids = [r.id for r in rows]
        at = [ids.index(c.id) for c in conns if c.id in ids]
        if at:
            idx = min(at) + 1
            while idx < len(rows) and rows[idx].struck:
                idx += 1
    rows.insert(idx, m)
    for i, r in enumerate(rows, 1):
        if r.sort_order != i:
            r.sort_order = i
    db.session.commit()


def _locked_connection_refusal(pipeline_id, m, current_conns, conn_positions):
    """After welding a connection can be added, never removed - and a material can no longer
    be spliced between two parts welded to each other (that removes their weld)."""
    target = []
    for val in conn_positions or []:
        c = _find_mat_by_id_or_pos(pipeline_id, val)
        if not c or (m and c.id == m.id) or c in target or _is_wire(c):
            continue
        target.append(c)
    removed = [c for c in current_conns if c not in target and not _is_wire(c)]
    if removed:
        return jsonify({
            "error": "connections_locked",
            "message": "A welder or inspector is assigned in this pipeline, so existing "
                       "connections cannot be removed ("
                       + ", ".join(f"{m.position if m else ''}-{c.position}" for c in removed)
                       + "). To take a material out, archive it.",
        }), 409
    added = [c for c in target if c not in current_conns]
    joined = [(a, b) for i, a in enumerate(target) for b in target[i + 1:]
              if (a in added or b in added) and b in a.connections]
    if joined:
        a, b = joined[0]
        return jsonify({
            "error": "connections_locked",
            "message": f"{a.position} and {b.position} are welded to each other. A welder or "
                       "inspector is assigned in this pipeline, so that weld cannot be removed "
                       "by inserting a material between them. Archive the part you are "
                       "replacing first, then connect the new material to its neighbours.",
        }), 409
    return None


def _weld_work(w):
    """What is recorded on a weld, for the confirmation dialog. Empty dict = nothing."""
    from app.models.welder import Welder

    def person(pid, legacy):
        if pid:
            p = Welder.query.get(pid)
            if p:
                return p.no or p.name or str(pid)
        return (legacy or "").strip()

    work = {}
    welder = person(w.welder_id, w.welder)
    inspector = person(w.inspector_id, w.inspector)
    if welder:
        work["welder"] = welder
    if inspector:
        work["inspector"] = inspector
    if w.date:
        work["date"] = w.date
    for key in ("visual", "endoscopy"):
        v = (getattr(w, key) or "").strip()
        if v and v.lower() not in ("n/a", "na", "n.a."):
            work[key] = v
    if (w.remarks or "").strip():
        work["remarks"] = True
    if (w.endoscopy_image_url or "").strip():
        work["photo"] = True
    if (w.endoscopy_video_url or "").strip():
        work["video"] = True
    return work


# --- Welds belong to materials, not to letters (phase 2) ------------------------------------
# A weld records the two materials it joins in material_a_id / material_b_id. The position
# letters between_a / between_b are only labels: after any relabelling they are refreshed
# from the materials (_refresh_weld_labels), so relabelling can never move a weld to other
# materials. A weld that has no ids yet ("needs checking") is still handled by its letters.

def _unmatched(q):
    return q.filter(db.or_(Weld.material_a_id.is_(None), Weld.material_b_id.is_(None)))


def _welds_on_joint(pipeline_id, a_id, a_pos, b_id, b_pos):
    """Active welds on the joint between two materials: by their ids, plus welds not matched
    yet whose letters are those two materials' letters."""
    q = Weld.query.filter_by(pipeline_id=pipeline_id, archived=False)
    out = []
    if a_id and b_id:
        out += q.filter(db.or_(
            db.and_(Weld.material_a_id == a_id, Weld.material_b_id == b_id),
            db.and_(Weld.material_a_id == b_id, Weld.material_b_id == a_id),
        )).all()
    if a_pos and b_pos:
        out += [w for w in _unmatched(q).filter(db.or_(
            db.and_(Weld.between_a == a_pos, Weld.between_b == b_pos),
            db.and_(Weld.between_a == b_pos, Weld.between_b == a_pos),
        )).all() if w not in out]
    return out


def _welds_on_material(pipeline_id, m_id, pos):
    """Active welds on a material: by id, plus welds not matched yet that carry its letter."""
    q = Weld.query.filter_by(pipeline_id=pipeline_id, archived=False)
    out = []
    if m_id:
        out += q.filter(db.or_(Weld.material_a_id == m_id, Weld.material_b_id == m_id)).all()
    if pos:
        out += [w for w in _unmatched(q).filter(db.or_(Weld.between_a == pos, Weld.between_b == pos)).all()
                if w not in out]
    return out


def _resolve_letters(pipeline_id, pos_a, pos_b, mats=None):
    """(id_a, id_b) when each letter is the letter of exactly one active material of the
    pipeline and they differ - the same rule migration 009 used. Otherwise None."""
    if not pos_a or not pos_b:
        return None
    if mats is None:
        mats = PipelineMaterial.query.filter_by(pipeline_id=pipeline_id, archived=False).all()
    a = [m.id for m in mats if m.position == pos_a]
    b = [m.id for m in mats if m.position == pos_b]
    if len(a) == 1 and len(b) == 1 and a[0] != b[0]:
        return a[0], b[0]
    return None


def _ensure_weld_ids(pipeline_id):
    """Give active welds without ids their materials from their letters, where that is
    unambiguous. Must run before letters change, while the letters still describe the joint."""
    mats = PipelineMaterial.query.filter_by(pipeline_id=pipeline_id, archived=False).all()
    for w in _unmatched(Weld.query.filter_by(pipeline_id=pipeline_id, archived=False)).all():
        ids = _resolve_letters(pipeline_id, w.between_a, w.between_b, mats)
        if ids:
            w.material_a_id, w.material_b_id = ids
    db.session.flush()


def _refresh_weld_labels(pipeline_id):
    """between_a / between_b = the current letters of the weld's two materials."""
    pos = {m.id: m.position for m in PipelineMaterial.query.filter_by(pipeline_id=pipeline_id, archived=False)}
    for w in Weld.query.filter_by(pipeline_id=pipeline_id, archived=False).filter(
            Weld.material_a_id.isnot(None), Weld.material_b_id.isnot(None)).all():
        a, b = pos.get(w.material_a_id), pos.get(w.material_b_id)
        if a and w.between_a != a:
            w.between_a = a
        if b and w.between_b != b:
            w.between_b = b
    db.session.flush()


def _is_wire(pm):
    pmat = pm.project_material if pm else None
    gm = pmat.global_material if pmat else None
    return bool(gm and (gm.category or "").strip().lower() == "welding wire")


def _welds_deleted_by_connection_change(pipeline_id, own_pos, current_conns, conn_positions,
                                        own_id=None, start_of_plumbing=False):
    """Welds that _update_connections would delete - worked out without changing anything.

    current_conns: the material's connections now ([] for a new material). Mirrors
    _update_connections: welds on removed connections, and - when the connections change or
    the material is the start - the weld between the two connected parts that are joined to
    each other (_split_linked_pair, the "inserted between" rule).
    """
    target = []
    for val in conn_positions or []:
        c = _find_mat_by_id_or_pos(pipeline_id, val)
        if not c or (own_id and c.id == own_id) or c in target or _is_wire(c):
            continue
        target.append(c)

    welds = []
    for rem in current_conns:
        if rem not in target:
            welds += _welds_on_joint(pipeline_id, own_id, own_pos, rem.id, rem.position)

    changed = {c.id for c in current_conns} != {c.id for c in target}
    if changed or start_of_plumbing:
        conns = [c for c in target if not c.archived and c.id != own_id]
        pairs = [(a, b) for i, a in enumerate(conns) for b in conns[i + 1:] if b in a.connections]
        if len(pairs) == 1:
            a, b = pairs[0]
            welds += _welds_on_joint(pipeline_id, a.id, a.position, b.id, b.position)
    return welds


def _confirm_weld_deletion(welds, data):
    """None when the action may go ahead, otherwise the 409 response asking to confirm."""
    seen, at_risk = set(), []
    for w in welds:
        if w.id in seen:
            continue
        seen.add(w.id)
        work = _weld_work(w)
        if work:
            at_risk.append((w, work))
    if not at_risk:
        return None
    try:
        confirmed = {int(i) for i in (data or {}).get("confirmDeleteWelds") or []}
    except (TypeError, ValueError):
        confirmed = set()
    if {w.id for w, _ in at_risk} <= confirmed:
        return None
    return jsonify({
        "error": "confirm_weld_deletion",
        "message": "This change would delete weld(s) that already have recorded work.",
        "welds": [{
            "id": w.id, "weldNo": w.weld_no, "betweenA": w.between_a, "betweenB": w.between_b,
            **work,
        } for w, work in sorted(at_risk, key=lambda x: (_weld_no_int(x[0].weld_no) or 0, x[0].id))],
    }), 409


def _find_mat_by_id_or_pos(pipeline_id, val):
    if val is None:
        return None
    if isinstance(val, int) or (isinstance(val, str) and str(val).strip().isdigit()):
        mat = PipelineMaterial.query.filter_by(pipeline_id=pipeline_id, id=int(val), archived=False).first()
        if mat:
            return mat
    return PipelineMaterial.query.filter_by(pipeline_id=pipeline_id, position=str(val).strip(), archived=False).first()


def _split_linked_pair(m, pipeline_id):
    """Break the direct link between two of m's connections that are joined to each other.

    Connecting a new material to R and S, where R-S are already welded together, means it is
    being spliced into that segment: R-S must go so the line becomes R-m-S. Only acts when
    exactly one such pair exists - with two of them there is no single correct answer.
    """
    conns = [c for c in m.connections if not c.archived and c.id != m.id]
    pairs = []
    for i, a in enumerate(conns):
        for b in conns[i + 1:]:
            if b in a.connections:
                pairs.append((a, b))
    if len(pairs) != 1:
        return None

    a, b = pairs[0]
    if b in a.connections:
        a.connections.remove(b)
    if a in b.connections:
        b.connections.remove(a)

    for w in _welds_on_joint(pipeline_id, a.id, a.position, b.id, b.position):
        db.session.delete(w)
    db.session.commit()
    return a, b


def _reposition_by_connections(m, pipeline_id):
    """Move m so that its position follows the materials it is connected to.

    - start of plumbing        -> first slot, everything else shifts down
    - has connections          -> immediately after its lowest-positioned connection
    - no connections           -> left where it is

    Every material is then relabelled A, B, C... over the new order and each weld's
    between_a / between_b is remapped, because welds reference position letters, not ids.

    Deliberately standalone: the existing _renumber_positions / reorder paths are untouched.
    Never after welding: letters are fixed then (see _place_in_gap).
    """
    if _numbering_frozen(pipeline_id):
        return
    _ensure_weld_ids(pipeline_id)
    mats = PipelineMaterial.query.filter_by(
        pipeline_id=pipeline_id, archived=False
    ).all()
    mats.sort(key=lambda x: _letter_to_pos(x.position))
    others = [x for x in mats if x.id != m.id]
    if not others:
        return

    if m.start_of_plumbing:
        target_idx = 0
    else:
        conns = [c for c in m.connections if not c.archived and c.id != m.id]
        if not conns:
            return
        anchor = min(conns, key=lambda c: _letter_to_pos(c.position))
        other_ids = [x.id for x in others]
        if anchor.id not in other_ids:
            return
        target_idx = other_ids.index(anchor.id) + 1

    ordered = others[:target_idx] + [m] + others[target_idx:]
    if [x.id for x in ordered] == [x.id for x in mats]:
        return  # already in the right slot

    pos_map = {}
    for idx, x in enumerate(ordered, 1):
        new_pos = _pos_letter(idx)
        if x.position != new_pos:
            pos_map[x.position] = new_pos
            x.position = new_pos
    db.session.commit()

    if pos_map:
        # Welds with ids simply take their materials' new letters; only welds not matched
        # yet still have their letters remapped.
        for w in _unmatched(Weld.query.filter_by(pipeline_id=pipeline_id, archived=False)).all():
            if w.between_a in pos_map:
                w.between_a = pos_map[w.between_a]
            if w.between_b in pos_map:
                w.between_b = pos_map[w.between_b]
        _refresh_weld_labels(pipeline_id)
        db.session.commit()


def _update_connections(m, conn_positions, pipeline_id):
    """Update connections for a pipeline material by position letters or IDs."""
    target_connected = []
    for pos_or_id in conn_positions:
        connected = _find_mat_by_id_or_pos(pipeline_id, pos_or_id)
        if not connected or connected.id == m.id or connected in target_connected:
            continue
        if connected.project_material and connected.project_material.global_material:
            if (connected.project_material.global_material.category or "").strip().lower() == "welding wire":
                continue
        target_connected.append(connected)

    # Find removed connections
    removed = [c for c in m.connections if c not in target_connected]

    # Delete welds for removed connections
    _ensure_weld_ids(pipeline_id)
    for rem in removed:
        for w in _welds_on_joint(pipeline_id, m.id, m.position, rem.id, rem.position):
            db.session.delete(w)

        if m in rem.connections:
            rem.connections.remove(m)

    conns_changed = {c.id for c in m.connections} != {c.id for c in target_connected}

    # Set new connections
    m.connections = target_connected
    for connected in target_connected:
        if m not in connected.connections:
            connected.connections.append(m)

    db.session.commit()

    # Let the connections decide where this material sits. Only when they actually changed,
    # so editing anything else on a material never reshuffles the pipeline.
    #
    # Moving it is only right when it was spliced into an existing weld: connected to R and S
    # that were welded together, the line becomes R-m-S and m belongs between them. Connected
    # to a single part, or to two parts that were never joined, it is a branch or a tie-in and
    # keeps the slot it already has - the end of the list for a new material, where it was for
    # an edited one. Repositioning those dragged them up next to the part they hang off and
    # pushed the rest of the pipeline down.
    if (conns_changed or m.start_of_plumbing) and not _numbering_frozen(pipeline_id):
        spliced = _split_linked_pair(m, pipeline_id)
        if spliced or m.start_of_plumbing:
            _reposition_by_connections(m, pipeline_id)

    _sync_and_renumber_welds(pipeline_id)


def _sync_and_renumber_welds(pipeline_id):
    """Synchronize welds with active material connections, eliminate duplicates, and renumber sequentially 1..N."""
    mats = PipelineMaterial.query.filter_by(
        pipeline_id=pipeline_id, archived=False
    ).order_by(db.func.length(PipelineMaterial.position), PipelineMaterial.position).all()
    mat_positions = {m.position for m in mats if m.position}
    mat_by_id = {m.id: m for m in mats}
    _ensure_weld_ids(pipeline_id)

    # 1. Clean up invalid/dangling and duplicate welds. A weld with ids is identified by its
    #    two materials; one not matched yet ("needs checking") still by its letters.
    welds = Weld.query.filter_by(pipeline_id=pipeline_id, archived=False).order_by(Weld.id).all()
    valid_welds = []
    seen_pairs = set()        # joints that have a weld: ("id", lo, hi) or ("pos", a, b)
    by_pair = {}

    for w in welds:
        if w.material_a_id and w.material_b_id:
            if w.material_a_id not in mat_by_id or w.material_b_id not in mat_by_id:
                db.session.delete(w)          # one of its materials is no longer active
                continue
            pair = ("id",) + tuple(sorted((w.material_a_id, w.material_b_id)))
        else:
            if (not w.between_a or not w.between_b
                    or w.between_a not in mat_positions or w.between_b not in mat_positions):
                # Letters that no longer describe a joint. An empty weld goes; one with
                # recorded work stays, as "needs checking", for someone to assign.
                if not _weld_work(w):
                    db.session.delete(w)
                continue
            pair = ("pos",) + tuple(sorted([w.between_a, w.between_b], key=_letter_to_pos))
        by_pair.setdefault(pair, []).append(w)

    # Two or more welds on the same joint: keep the one with the most recorded details
    # (welder, inspector, date, results, remarks, photo, video) and delete the others. With
    # the same amount of detail the oldest one is kept.
    for pair, group in by_pair.items():
        keep = group[0]
        if len(group) > 1:
            keep = max(group, key=lambda w: (len(_weld_work(w)), -w.id))
            for w in group:
                if w is not keep:
                    db.session.delete(w)
        seen_pairs.add(pair)
        valid_welds.append(keep)

    # 2. Ensure every active connection pair has a weld. A joint whose weld is not matched
    #    yet (letters only) counts as having one - no second weld is added next to it.
    for m in mats:
        for conn in m.connections:
            if not conn.archived and conn.id in mat_by_id and m.position and conn.position:
                id_pair = ("id",) + tuple(sorted((m.id, conn.id)))
                pos_pair = ("pos",) + tuple(sorted([m.position, conn.position], key=_letter_to_pos))
                if id_pair in seen_pairs or pos_pair in seen_pairs:
                    continue
                first, second = sorted((m, conn), key=lambda x: _letter_to_pos(x.position))
                w = Weld(
                    pipeline_id=pipeline_id,
                    weld_no="0",
                    material_a_id=first.id,
                    material_b_id=second.id,
                    between_a=first.position,
                    between_b=second.position,
                )
                db.session.add(w)
                valid_welds.append(w)
                seen_pairs.add(id_pair)

    # Labels: every weld with ids carries its materials' current letters
    for w in valid_welds:
        if w.material_a_id in mat_by_id and w.material_b_id in mat_by_id:
            w.between_a = mat_by_id[w.material_a_id].position
            w.between_b = mat_by_id[w.material_b_id].position

    # 3. Assign weld numbers, in physical order along the run.
    valid_welds.sort(key=lambda w: (_letter_to_pos(w.between_a), _letter_to_pos(w.between_b)))

    if _numbering_frozen(pipeline_id):
        # Frozen: a number that has been given to a welder is what is written on the pipe
        # and in the issued documents, so it never changes. Welds that already have one
        # keep it; only welds without a number get one, taking the lowest free number
        # first (a deleted weld releases its number) and then continuing past the highest.
        # The numbers of struck-through welds stay taken: they are in the record.
        taken = {n for n in (_weld_no_int(r.weld_no) for r in Weld.query.filter_by(
            pipeline_id=pipeline_id, struck=True).all()) if n}
        needs_number = []
        for w in valid_welds:
            n = _weld_no_int(w.weld_no)
            if n is None or n in taken:
                needs_number.append(w)
            else:
                taken.add(n)
        if needs_number:
            free = (i for i in itertools.count(1) if i not in taken)
            for w in needs_number:
                w.weld_no = str(next(free))
    else:
        for idx, w in enumerate(valid_welds, 1):
            w.weld_no = str(idx)

    db.session.commit()
    _sync_sort_order(pipeline_id)       # before welding the list follows the (new) letters


def _weld_no_int(value):
    """A weld number as an int, or None when it is missing or not a number.
    "0" is the placeholder used for a weld that has just been created."""
    try:
        n = int(str(value).strip())
    except (TypeError, ValueError):
        return None
    return n if n > 0 else None


def _numbering_frozen(pipeline_id):
    """True once any weld in this pipeline has a welder or an inspector.

    From that moment the numbering is out of our hands: it is on the pipe and in the
    documents the welders work from, so nothing may renumber it.

    Written as a plain SELECT ... TOP 1 rather than SELECT EXISTS(...): SQL Server only
    accepts EXISTS inside a WHERE clause, never in a select list, so the EXISTS form fails
    with a syntax error on the production database while working fine on SQLite.
    """
    return db.session.query(Weld.id).filter(
        Weld.pipeline_id == pipeline_id,
        # a struck-through weld still counts: it was welded, and striking it never unlocks
        db.or_(Weld.archived == False, Weld.struck == True),  # noqa: E712
        db.or_(Weld.welder_id.isnot(None), Weld.inspector_id.isnot(None)),
    ).first() is not None


def _renumber_positions(pipeline_id):
    """Renumber positions sequentially after a deletion and synchronize welds.

    Welds are remapped by MATERIAL ID, never by letter. A letter-keyed map silently breaks
    the moment two materials share a letter: the map holds one entry per old letter, the
    second material overwrites the first, and every weld pointing at that letter is rewired
    to the wrong material. Resolving each weld end to a material id first cannot collide.
    """
    if _numbering_frozen(pipeline_id):
        # After welding the letters are part of the record: nothing is relabelled.
        _sync_and_renumber_welds(pipeline_id)
        return
    _ensure_weld_ids(pipeline_id)
    mats = PipelineMaterial.query.filter_by(
        pipeline_id=pipeline_id, archived=False
    ).order_by(db.func.length(PipelineMaterial.position), PipelineMaterial.position).all()

    # Welds with ids follow their materials by themselves (labels refreshed below). Only welds
    # not matched yet are resolved from the letters as they stand now, before relabelling.
    welds = _unmatched(Weld.query.filter_by(pipeline_id=pipeline_id, archived=False)).all()
    old_pos_to_id = {}
    for m in mats:
        if m.position:
            old_pos_to_id.setdefault(m.position, m.id)
    weld_ends = {
        w.id: (old_pos_to_id.get(w.between_a), old_pos_to_id.get(w.between_b))
        for w in welds
    }

    changed = False
    for idx, m in enumerate(mats, 1):
        new_pos = _pos_letter(idx)
        if m.position != new_pos:
            m.position = new_pos
            changed = True
    db.session.commit()

    # Re-point each weld at the SAME materials, under their new letters. An end that no
    # longer resolves is left alone; _sync_and_renumber_welds drops it as dangling.
    if changed:
        id_to_new_pos = {m.id: m.position for m in mats}
        for w in welds:
            a_id, b_id = weld_ends.get(w.id, (None, None))
            if a_id in id_to_new_pos:
                w.between_a = id_to_new_pos[a_id]
            if b_id in id_to_new_pos:
                w.between_b = id_to_new_pos[b_id]
        _refresh_weld_labels(pipeline_id)
        db.session.commit()

    _sync_and_renumber_welds(pipeline_id)
    _sync_sort_order(pipeline_id)


def _serialize(m):
    pm = m.project_material
    gm = pm.global_material if pm else None
    return {
        "id": m.id,
        "pipelineId": m.pipeline_id,
        "projectMaterialId": m.project_material_id,
        "globalMaterialId": gm.id if gm else None,
        "position": m.position,
        "sortOrder": m.sort_order,
        "struck": bool(m.struck),
        "wazNo": m.waz_no,
        "startOfPlumbing": m.start_of_plumbing,
        "endOfPlumbing": m.end_of_plumbing,
        "connections": [
            c.id for c in m.connections
            if not c.archived and not (c.project_material and c.project_material.global_material and (c.project_material.global_material.category or '').strip().lower() == 'welding wire')
        ],
        # Project material fields
        "certificate": pm.certificate if pm else None,
        "heatNo": pm.heat_no if pm else None,
        "wazPdfUrl": pm.waz_pdf_url if pm else None,
        "wazPackageUrl": m.waz_package_url or "",
        # Global material fields
        "category": gm.category if gm else None,
        "itemDescription": gm.item_description if gm else None,
        "dn1": gm.dn1 if gm else None,
        "dn2": gm.dn2 if gm else None,
        "dn3": gm.dn3 if gm else None,
        "dn4": gm.dn4 if gm else None,
        "dn5": gm.dn5 if gm else None,
        "dn6": gm.dn6 if gm else None,
        "diameter": gm.diameter if gm else None,
        "thickness": gm.thickness if gm else None,
        "surface": gm.surface if gm else None,
        "materialCode": gm.material_code if gm else None,
        "dienNo": gm.dien_no if gm else None,
    }
