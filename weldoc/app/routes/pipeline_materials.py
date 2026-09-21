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

    # Determine position (next sequential letter, preventing duplicates)
    existing_mats = PipelineMaterial.query.filter_by(
        pipeline_id=pipeline_id, archived=False
    ).all()
    existing_positions = {m.position for m in existing_mats if m.position}
    req_pos = (data.get("position") or "").strip().upper()
    if req_pos and req_pos not in existing_positions:
        position = req_pos
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
                weld_no=str(weld_count + 1),
                between_a=prev.position,
                between_b=m.position,
            )
            db.session.add(new_weld)
            db.session.commit()

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
            _archive_pipeline_material(m)
        else:
            db.session.commit()
            # Its letter was released on archive and it comes back with no connections,
            # so it goes to the end of the run until someone reconnects it.
            if not m.position:
                active = PipelineMaterial.query.filter_by(
                    pipeline_id=m.pipeline_id, archived=False
                ).count()
                m.position = _pos_letter(max(active, 1))
                db.session.commit()
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

    if "connections" in data:
        _update_connections(m, data["connections"], m.pipeline_id)
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
    _archive_pipeline_material(m)
    return jsonify({"ok": True}), 200


@pipeline_materials_bp.route("/<int:pm_id>/restore", methods=["POST"])
def restore_pipeline_material(pm_id):
    """Restore an archived pipeline material, upload new WAZ PDF, assign next sequential WAZ number, and regenerate package."""
    from app.models.project import Project
    from app.models.pipeline import Pipeline
    from app.sharepoint import upload_waz_to_project_folder, format_waz_filename

    m = PipelineMaterial.query.get_or_404(pm_id)
    pipeline = Pipeline.query.get_or_404(m.pipeline_id)
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

    m.archived = False

    # Assign next position letter
    existing_count = PipelineMaterial.query.filter_by(
        pipeline_id=m.pipeline_id, archived=False
    ).count()
    m.position = _pos_letter(existing_count + 1)

    # Assign next sequential WAZ number
    m.waz_no = _assign_waz_no(m.pipeline_id, m.project_material_id)
    db.session.commit()

    if file_content or (pm and pm.waz_pdf_url):
        _build_and_save_waz_package(m, file_content=file_content)

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
    old_pos_rows = db.session.execute(db.text("""
        SELECT id, position FROM weldoc_pipeline_materials
        WHERE pipeline_id = :pid AND archived = 0
    """), {"pid": pipeline_id}).fetchall()
    old_pos_to_id = {r.position: r.id for r in old_pos_rows if r.position}

    existing_welds = db.session.execute(db.text("""
        SELECT id, between_a, between_b, type, welding_wire, welder_id, inspector_id,
               date, visual, endoscopy, remarks
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

    # 1. Update all positions/flags in one batch using CASE
    if items:
        case_pos = " ".join(f"WHEN {int(i['id'])} THEN '{i['position']}'" for i in items)
        case_sop = " ".join(f"WHEN {int(i['id'])} THEN {1 if i.get('startOfPlumbing') else 0}" for i in items)
        case_eop = " ".join(f"WHEN {int(i['id'])} THEN {1 if i.get('endOfPlumbing') else 0}" for i in items)
        id_list = ",".join(str(int(i["id"])) for i in items)
        db.session.execute(db.text(f"""
            UPDATE weldoc_pipeline_materials SET
                position = CASE id {case_pos} END,
                start_of_plumbing = CASE id {case_sop} END,
                end_of_plumbing = CASE id {case_eop} END
            WHERE id IN ({id_list})
        """))

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
        WHERE pm.pipeline_id = :pid AND LOWER(RTRIM(LTRIM(ISNULL(gm.category, '')))) = 'welding wire'
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
        if kept is not None:
            weld_updates.append({
                "id": kept.id, "wno": str(idx), "ba": letters[0], "bb": letters[1],
            })
        else:
            weld_inserts.append({
                "pid": pipeline_id, "wno": str(idx), "ba": letters[0], "bb": letters[1],
            })

    if weld_updates:
        db.session.execute(db.text("""
            UPDATE weldoc_welds
            SET weld_no = :wno, between_a = :ba, between_b = :bb
            WHERE id = :id
        """), weld_updates)

    if weld_inserts:
        db.session.execute(db.text("""
            INSERT INTO weldoc_welds (pipeline_id, weld_no, between_a, between_b, archived)
            VALUES (:pid, :wno, :ba, :bb, 0)
        """), weld_inserts)

    db.session.commit()
    _sync_pipeline_waz_nos(pipeline_id)
    return jsonify({"status": "ok"}), 200


def _archive_pipeline_material(m):
    """Perform archive actions for a pipeline material:
    1. Bridge connections if exactly 2 active neighbors.
    2. Clear connections and delete direct welds.
    3. Renumber positions.
    4. Delete WAZ file from SharePoint if unique to this material, clear waz_no, and resequence remaining active WAZ numbers.
    """
    m.archived = True
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
    Weld.query.filter_by(pipeline_id=pipeline_id, archived=False).filter(
        db.or_(Weld.between_a == pos, Weld.between_b == pos)
    ).delete(synchronize_session=False)

    # Release the position letter. An archived material that keeps its letter collides with
    # whichever active material is relabelled onto it, and that duplicate then corrupts the
    # next renumber - welds get rewired to the wrong materials.
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

    Weld.query.filter_by(pipeline_id=pipeline_id, archived=False).filter(
        db.or_(
            db.and_(Weld.between_a == a.position, Weld.between_b == b.position),
            db.and_(Weld.between_a == b.position, Weld.between_b == a.position),
        )
    ).delete(synchronize_session=False)
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
    """
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
        welds = Weld.query.filter_by(pipeline_id=pipeline_id, archived=False).all()
        for w in welds:
            if w.between_a in pos_map:
                w.between_a = pos_map[w.between_a]
            if w.between_b in pos_map:
                w.between_b = pos_map[w.between_b]
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
    for rem in removed:
        Weld.query.filter_by(pipeline_id=pipeline_id, archived=False).filter(
            db.or_(
                db.and_(Weld.between_a == m.position, Weld.between_b == rem.position),
                db.and_(Weld.between_a == rem.position, Weld.between_b == m.position),
            )
        ).delete(synchronize_session=False)

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
    if conns_changed or m.start_of_plumbing:
        _split_linked_pair(m, pipeline_id)
        _reposition_by_connections(m, pipeline_id)

    _sync_and_renumber_welds(pipeline_id)


def _sync_and_renumber_welds(pipeline_id):
    """Synchronize welds with active material connections, eliminate duplicates, and renumber sequentially 1..N."""
    mats = PipelineMaterial.query.filter_by(
        pipeline_id=pipeline_id, archived=False
    ).order_by(db.func.length(PipelineMaterial.position), PipelineMaterial.position).all()
    mat_positions = {m.position for m in mats if m.position}

    # 1. Clean up invalid/dangling and duplicate welds
    welds = Weld.query.filter_by(pipeline_id=pipeline_id, archived=False).order_by(Weld.id).all()
    valid_welds = []
    seen_pairs = set()

    for w in welds:
        if not w.between_a or not w.between_b:
            db.session.delete(w)
            continue
        if w.between_a not in mat_positions or w.between_b not in mat_positions:
            db.session.delete(w)
            continue
        pair = tuple(sorted([w.between_a, w.between_b], key=_letter_to_pos))
        if pair in seen_pairs:
            db.session.delete(w)
            continue
        seen_pairs.add(pair)
        valid_welds.append(w)

    # 2. Ensure every active connection pair has a weld
    for m in mats:
        for conn in m.connections:
            if not conn.archived and m.position and conn.position:
                pair = tuple(sorted([m.position, conn.position], key=_letter_to_pos))
                if pair not in seen_pairs:
                    w = Weld(
                        pipeline_id=pipeline_id,
                        weld_no="0",
                        between_a=pair[0],
                        between_b=pair[1],
                    )
                    db.session.add(w)
                    valid_welds.append(w)
                    seen_pairs.add(pair)

    # 3. Assign weld numbers, in physical order along the run.
    valid_welds.sort(key=lambda w: (_letter_to_pos(w.between_a), _letter_to_pos(w.between_b)))

    if _numbering_frozen(pipeline_id):
        # Frozen: a number that has been given to a welder is what is written on the pipe
        # and in the issued documents, so it never changes. Welds that already have one
        # keep it; only welds without a number get one, taking the lowest free number
        # first (a deleted weld releases its number) and then continuing past the highest.
        taken = set()
        needs_number = []
        for w in valid_welds:
            n = _weld_no_int(w.weld_no)
            if n is None or n in taken:
                needs_number.append(w)
            else:
                taken.add(n)
        if needs_number:
            free = (i for i in range(1, len(valid_welds) + len(needs_number) + 2) if i not in taken)
            for w in needs_number:
                w.weld_no = str(next(free))
    else:
        for idx, w in enumerate(valid_welds, 1):
            w.weld_no = str(idx)

    db.session.commit()


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
        Weld.archived == False,  # noqa: E712
        db.or_(Weld.welder_id.isnot(None), Weld.inspector_id.isnot(None)),
    ).first() is not None


def _renumber_positions(pipeline_id):
    """Renumber positions sequentially after a deletion and synchronize welds.

    Welds are remapped by MATERIAL ID, never by letter. A letter-keyed map silently breaks
    the moment two materials share a letter: the map holds one entry per old letter, the
    second material overwrites the first, and every weld pointing at that letter is rewired
    to the wrong material. Resolving each weld end to a material id first cannot collide.
    """
    mats = PipelineMaterial.query.filter_by(
        pipeline_id=pipeline_id, archived=False
    ).order_by(db.func.length(PipelineMaterial.position), PipelineMaterial.position).all()

    # Resolve every weld end to a material id using the letters as they stand right now,
    # before any relabelling happens.
    welds = Weld.query.filter_by(pipeline_id=pipeline_id, archived=False).all()
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
        db.session.commit()

    _sync_and_renumber_welds(pipeline_id)


def _serialize(m):
    pm = m.project_material
    gm = pm.global_material if pm else None
    return {
        "id": m.id,
        "pipelineId": m.pipeline_id,
        "projectMaterialId": m.project_material_id,
        "globalMaterialId": gm.id if gm else None,
        "position": m.position,
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
