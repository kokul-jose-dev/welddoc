from flask import Blueprint, request, jsonify
from app.database import db
from app.models.pipeline_material import PipelineMaterial, pipeline_material_connections
from app.models.project_material import ProjectMaterial
from app.models.weld import Weld

pipeline_materials_bp = Blueprint("pipeline_materials", __name__)


def _pos_letter(n):
    """Convert position number to letter: 1→A, 2→B, etc."""
    return chr(64 + int(n))


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
    rows = query.order_by(PipelineMaterial.position).all()
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

    # Determine position (next letter)
    existing = PipelineMaterial.query.filter_by(
        pipeline_id=pipeline_id, archived=False
    ).count()
    position = data.get("position", _pos_letter(existing + 1))

    # Auto-assign WAZ number
    waz_no = _assign_waz_no(pipeline_id, project_material_id)

    # Check if another material with the same heat already has a waz_package_url in this pipeline
    waz_package_url = None
    pm_curr = ProjectMaterial.query.get(project_material_id)
    if pm_curr and pm_curr.heat_no:
        h_curr = pm_curr.heat_no.strip().lower()
        existing_sibling = PipelineMaterial.query.filter_by(
            pipeline_id=pipeline_id, archived=False
        ).all()
        for sib in existing_sibling:
            if sib.project_material and sib.project_material.heat_no:
                if sib.project_material.heat_no.strip().lower() == h_curr and sib.waz_package_url:
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
            _renumber_positions(m.pipeline_id)
            _sync_pipeline_waz_nos(m.pipeline_id)

    if "wazNo" in data:
        m.waz_no = data["wazNo"]

    pm = m.project_material
    new_cert = data.get("certificate", "")
    new_heat = data.get("heatNo", "")
    pm_changed = False

    if new_cert or new_heat:
        cert = new_cert or pm.certificate or ""
        heat = new_heat or pm.heat_no or ""
        if cert != (pm.certificate or "") or heat != (pm.heat_no or ""):
            # If existing project material has no cert/heat yet, just fill it in
            if not pm.certificate and not pm.heat_no:
                pm.certificate = cert
                pm.heat_no = heat
                pm_changed = True
            else:
                # Cert/heat changed — find or create a separate project material
                existing_pm = ProjectMaterial.query.filter_by(
                    project_id=pm.project_id,
                    global_material_id=pm.global_material_id,
                    certificate=cert,
                    heat_no=heat,
                ).first()
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
    proj_waz_name = format_waz_filename(
        item_desc=gm.item_description if gm else "",
        dn=gm.dn1 if gm else "",
        diameter=gm.diameter if gm else "",
        thickness=gm.thickness if gm else "",
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

    # Sync package URL and WAZ no across all pipeline materials sharing this heat number
    if pm.heat_no:
        h_norm = pm.heat_no.strip().lower()
        siblings = PipelineMaterial.query.filter_by(
            pipeline_id=m.pipeline_id, archived=False
        ).filter(PipelineMaterial.id != m.id).all()
        for sib in siblings:
            if sib.project_material and sib.project_material.heat_no:
                if sib.project_material.heat_no.strip().lower() == h_norm:
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

    heat_no = request.form.get("heatNo", "").strip() or pm.heat_no or ""
    certificate = request.form.get("certificate", "").strip() or pm.certificate or ""
    existing_pdf_url = request.form.get("existingPdfUrl", "").strip()

    if heat_no != (pm.heat_no or "") or certificate != (pm.certificate or ""):
        existing_pm = ProjectMaterial.query.filter_by(
            project_id=pm.project_id,
            global_material_id=pm.global_material_id,
            certificate=certificate,
            heat_no=heat_no,
        ).first()
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
        proj_waz_name = format_waz_filename(
            item_desc=gm.item_description if gm else "",
            dn=gm.dn1 if gm else "",
            diameter=gm.diameter if gm else "",
            thickness=gm.thickness if gm else "",
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

    # 3. Delete all welds for this pipeline
    db.session.execute(db.text("""
        DELETE FROM weldoc_welds WHERE pipeline_id = :pid AND archived = 0
    """), {"pid": pipeline_id})

    # 4. Rebuild connections and welds in batch
    pos_to_id = {item["position"]: item["id"] for item in items}
    weld_no = 1
    seen_conn = set()
    seen_weld = set()
    conn_inserts = []
    weld_inserts = []

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

            # Welds for unique position pairs
            pair_weld = tuple(sorted([item["position"], conn_pos]))
            if pair_weld not in seen_weld:
                seen_weld.add(pair_weld)
                weld_inserts.append({
                    "pid": pipeline_id, "wno": str(weld_no),
                    "ba": pair_weld[0], "bb": pair_weld[1],
                })
                weld_no += 1

    if conn_inserts:
        conn_values = ",".join(f"({int(c['a'])},{int(c['b'])})" for c in conn_inserts)
        db.session.execute(db.text(f"""
            INSERT INTO weldoc_pipeline_material_connections (pipeline_material_id, connected_id)
            VALUES {conn_values}
        """))

    if weld_inserts:
        weld_values = ",".join(
            f"({int(w['pid'])},'{w['wno']}','{w['ba']}','{w['bb']}',0)" for w in weld_inserts
        )
        db.session.execute(db.text(f"""
            INSERT INTO weldoc_welds (pipeline_id, weld_no, between_a, between_b, archived)
            VALUES {weld_values}
        """))

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
    db.session.commit()
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
                pkg_name = format_waz_filename(
                    item_desc=gm.item_description if gm else "",
                    dn=gm.dn1 if gm else "",
                    diameter=gm.diameter if gm else "",
                    thickness=gm.thickness if gm else "",
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

    heat_groups = []
    seen_heats = {}

    for m in active_mats:
        pm = m.project_material
        if not pm or not pm.certificate or not (pm.heat_no or "").strip():
            if m.waz_no:
                m.waz_no = None
                m.waz_package_url = None
            continue

        heat_key = pm.heat_no.strip().lower()
        if heat_key not in seen_heats:
            group = {
                "heat_key": heat_key,
                "old_waz": m.waz_no,
                "mats": [m]
            }
            seen_heats[heat_key] = group
            heat_groups.append(group)
        else:
            seen_heats[heat_key]["mats"].append(m)

    def _waz_sort_key(grp):
        old_w = grp["old_waz"]
        if old_w:
            match = re.match(r'^Z(\d+)$', old_w.strip(), re.IGNORECASE)
            if match:
                return (0, int(match.group(1)))
        return (1, grp["mats"][0].id)

    heat_groups.sort(key=_waz_sort_key)

    regen_count = 0
    valid_filenames = set()

    for idx, grp in enumerate(heat_groups, 1):
        target_waz = f"Z{idx:03d}"
        old_waz = grp["old_waz"]
        waz_changed = (old_waz != target_waz)

        primary_m = grp["mats"][0]
        pm = primary_m.project_material
        gm = pm.global_material if pm else None
        project = Project.query.get(pm.project_id) if pm else None

        # Build target filename
        target_fname = format_waz_filename(
            item_desc=gm.item_description if gm else "",
            dn=gm.dn1 if gm else "",
            diameter=gm.diameter if gm else "",
            thickness=gm.thickness if gm else "",
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
    Same heat number in same pipeline = same WAZ no.
    Different heat numbers = unique sequential WAZ numbers (Z001, Z002, etc.)."""
    import re
    pm = ProjectMaterial.query.get(project_material_id)
    if not pm or not pm.certificate or not (pm.heat_no or "").strip():
        return None  # Don't assign WAZ number yet

    heat_target = pm.heat_no.strip().lower()

    # Query all active pipeline materials in this pipeline
    existing_mats = PipelineMaterial.query.filter_by(
        pipeline_id=pipeline_id, archived=False
    ).all()

    # Check if any existing material in this pipeline has the same heat number and an assigned waz_no
    for mat in existing_mats:
        if mat.project_material and mat.project_material.heat_no:
            if mat.project_material.heat_no.strip().lower() == heat_target and mat.waz_no:
                return mat.waz_no

    # If new heat number in the pipeline, find max existing Z number to avoid any collisions
    used_nums = []
    for mat in existing_mats:
        if mat.waz_no:
            match = re.match(r'^Z(\d+)$', mat.waz_no.strip(), re.IGNORECASE)
            if match:
                used_nums.append(int(match.group(1)))

    next_num = max(used_nums, default=0) + 1
    return f"Z{next_num:03d}"


def _sync_pipeline_waz_nos(pipeline_id):
    """Ensure 1 heat number = 1 WAZ number per pipeline, eliminate duplicate Z numbers across different heats,
    and propagate waz_package_url across matching heat numbers."""
    import re
    mats = PipelineMaterial.query.filter_by(
        pipeline_id=pipeline_id, archived=False
    ).order_by(PipelineMaterial.position, PipelineMaterial.id).all()

    heat_to_waz = {}
    waz_to_heat = {}
    heat_to_pkg = {}
    used_nums = set()

    # First pass: collect existing unambiguous assignments & package URLs
    for m in mats:
        pm = m.project_material
        if not pm or not pm.certificate or not (pm.heat_no or "").strip():
            continue
        heat_key = pm.heat_no.strip().lower()

        if m.waz_package_url and heat_key not in heat_to_pkg:
            heat_to_pkg[heat_key] = m.waz_package_url

        if m.waz_no:
            waz = m.waz_no.strip().upper()
            match = re.match(r'^Z(\d+)$', waz)
            if match:
                num = int(match.group(1))
                if waz not in waz_to_heat and heat_key not in heat_to_waz:
                    heat_to_waz[heat_key] = waz
                    waz_to_heat[waz] = heat_key
                    used_nums.add(num)

    # Second pass: assign canonical WAZ number and propagate package URL to all matching rows
    changed = False
    next_num = 1
    for m in mats:
        pm = m.project_material
        if not pm or not pm.certificate or not (pm.heat_no or "").strip():
            if m.waz_no is not None:
                m.waz_no = None
                changed = True
            continue

        heat_key = pm.heat_no.strip().lower()

        if heat_key not in heat_to_waz:
            while next_num in used_nums:
                next_num += 1
            assigned_waz = f"Z{next_num:03d}"
            used_nums.add(next_num)
            heat_to_waz[heat_key] = assigned_waz
            waz_to_heat[assigned_waz] = heat_key

        canonical_waz = heat_to_waz[heat_key]
        if m.waz_no != canonical_waz:
            m.waz_no = canonical_waz
            changed = True

        if heat_key in heat_to_pkg and m.waz_package_url != heat_to_pkg[heat_key]:
            m.waz_package_url = heat_to_pkg[heat_key]
            changed = True

    if changed:
        db.session.commit()


def _build_and_save_waz_package_with_bytes(m, file_content=None):
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
        "diameter": gm.diameter or "" if gm else "",
        "thickness": gm.thickness or "" if gm else "",
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
        pkg_name = format_waz_filename(
            item_desc=gm.item_description if gm else "",
            dn=gm.dn1 if gm else "",
            diameter=gm.diameter if gm else "",
            thickness=gm.thickness if gm else "",
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


def _build_and_save_waz_package(m, file_content=None):
    pkg_url, _ = _build_and_save_waz_package_with_bytes(m, file_content)
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

    # Set new connections
    m.connections = target_connected
    for connected in target_connected:
        if m not in connected.connections:
            connected.connections.append(m)

    db.session.commit()
    _sync_and_renumber_welds(pipeline_id)


def _sync_and_renumber_welds(pipeline_id):
    """Synchronize welds with active material connections, eliminate duplicates, and renumber sequentially 1..N."""
    mats = PipelineMaterial.query.filter_by(
        pipeline_id=pipeline_id, archived=False
    ).order_by(PipelineMaterial.position).all()
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
        pair = tuple(sorted([w.between_a, w.between_b]))
        if pair in seen_pairs:
            db.session.delete(w)
            continue
        seen_pairs.add(pair)
        valid_welds.append(w)

    # 2. Ensure every active connection pair has a weld
    for m in mats:
        for conn in m.connections:
            if not conn.archived and m.position and conn.position:
                pair = tuple(sorted([m.position, conn.position]))
                if pair not in seen_pairs:
                    w = Weld(
                        pipeline_id=pipeline_id,
                        weld_no="0",
                        between_a=min(m.position, conn.position),
                        between_b=max(m.position, conn.position),
                    )
                    db.session.add(w)
                    valid_welds.append(w)
                    seen_pairs.add(pair)

    # 3. Sort welds by (between_a, between_b) and assign unique sequential weld_no: 1, 2, 3...
    valid_welds.sort(key=lambda w: (w.between_a or "", w.between_b or ""))
    for idx, w in enumerate(valid_welds, 1):
        w.weld_no = str(idx)

    db.session.commit()


def _renumber_positions(pipeline_id):
    """Renumber positions sequentially after a deletion and synchronize welds."""
    mats = PipelineMaterial.query.filter_by(
        pipeline_id=pipeline_id, archived=False
    ).order_by(PipelineMaterial.position).all()
    pos_map = {}
    for idx, m in enumerate(mats, 1):
        new_pos = _pos_letter(idx)
        if m.position != new_pos:
            pos_map[m.position] = new_pos
            m.position = new_pos
    db.session.commit()

    # Re-map weld between letters
    if pos_map:
        welds = Weld.query.filter_by(pipeline_id=pipeline_id, archived=False).all()
        for w in welds:
            if w.between_a in pos_map:
                w.between_a = pos_map[w.between_a]
            if w.between_b in pos_map:
                w.between_b = pos_map[w.between_b]
        db.session.commit()

    _sync_and_renumber_welds(pipeline_id)


def _serialize(m):
    pm = m.project_material
    gm = pm.global_material if pm else None
    return {
        "id": m.id,
        "pipelineId": m.pipeline_id,
        "projectMaterialId": m.project_material_id,
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
