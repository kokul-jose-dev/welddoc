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

    m = PipelineMaterial(
        pipeline_id=pipeline_id,
        project_material_id=project_material_id,
        position=position,
        waz_no=waz_no,
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
            m.connections = []
            pos = m.position
            Weld.query.filter_by(pipeline_id=m.pipeline_id, archived=False).filter(
                db.or_(Weld.between_a == pos, Weld.between_b == pos)
            ).delete(synchronize_session=False)
            db.session.commit()
            _renumber_positions(m.pipeline_id)
        else:
            db.session.commit()
            _renumber_positions(m.pipeline_id)

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

    # Auto-assign WAZ number if certificate + heat are now filled and waz_no is empty
    if pm_changed and pm.certificate and pm.heat_no and not m.waz_no:
        m.waz_no = _assign_waz_no(m.pipeline_id, m.project_material_id)
        siblings = PipelineMaterial.query.filter_by(
            pipeline_id=m.pipeline_id, project_material_id=m.project_material_id, archived=False
        ).filter(PipelineMaterial.id != m.id).all()
        for sib in siblings:
            if not sib.waz_no:
                sib.waz_no = m.waz_no

    db.session.commit()

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

    project = Project.query.get(pm.project_id)
    if not project.sharepoint_drive_id or not project.sharepoint_folder_id:
        return jsonify({"error": "No SharePoint folder configured for this project."}), 400

    file_content = file.read()
    content_type = file.content_type or "application/pdf"

    # 1. Upload to project-level WAZ folder (existing behavior)
    url = upload_waz_to_project_folder(
        project.sharepoint_drive_id,
        project.sharepoint_folder_id,
        pm.heat_no or "unknown", pm.certificate or "unknown",
        file_content, content_type
    )

    if not url:
        return jsonify({"error": "Failed to upload to SharePoint"}), 500

    pm.waz_pdf_url = url
    if not m.waz_no and pm.certificate and pm.heat_no:
        m.waz_no = _assign_waz_no(m.pipeline_id, m.project_material_id)
    # 2. Generate Cover Letter, merge with raw WAZ PDF, and upload package to pipeline WAZ folder
    _build_and_save_waz_package(m, file_content=file_content)

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
    """Archive a pipeline material."""
    m = PipelineMaterial.query.get_or_404(pm_id)
    m.archived = True
    # Remove connections
    m.connections = []
    db.session.commit()

    # Delete associated welds
    pos = m.position
    Weld.query.filter_by(pipeline_id=m.pipeline_id, archived=False).filter(
        db.or_(Weld.between_a == pos, Weld.between_b == pos)
    ).delete(synchronize_session=False)
    db.session.commit()

    # Renumber remaining positions
    _renumber_positions(m.pipeline_id)

    return jsonify({"ok": True}), 200


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

    db.session.commit()
    return jsonify({"ok": True}), 200


def _assign_waz_no(pipeline_id, project_material_id):
    """Auto-assign WAZ number only if project material has certificate + heat number.
    Same project_material_id in same pipeline = same WAZ no."""
    # Check if project material has certificate and heat number
    pm = ProjectMaterial.query.get(project_material_id)
    if not pm or not pm.certificate or not pm.heat_no:
        return None  # Don't assign WAZ number yet

    # Check if same project material already exists in this pipeline
    existing_same = PipelineMaterial.query.filter_by(
        pipeline_id=pipeline_id, project_material_id=project_material_id, archived=False
    ).first()
    if existing_same and existing_same.waz_no:
        return existing_same.waz_no

    # Get all distinct WAZ numbers already used in this pipeline
    used = db.session.query(PipelineMaterial.waz_no).filter_by(
        pipeline_id=pipeline_id, archived=False
    ).filter(PipelineMaterial.waz_no.isnot(None)).distinct().count()

    return f"Z{used + 1:03d}"


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
    user_name = flask_session.get("user", {}).get("name", "") if flask_session else ""

    cover_data = {
        "user_name": user_name,
        "date": date.today().strftime("%d/%m/%Y"),
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
        pkg_name = f"WAZ_{m.waz_no or 'WAZ'}_{pm.heat_no or 'unknown'}.pdf"
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

        # Auto-create weld if not exists
        existing_weld = Weld.query.filter_by(
            pipeline_id=pipeline_id, archived=False
        ).filter(
            db.or_(
                db.and_(Weld.between_a == m.position, Weld.between_b == connected.position),
                db.and_(Weld.between_a == connected.position, Weld.between_b == m.position),
            )
        ).first()
        if not existing_weld:
            weld_count = Weld.query.filter_by(pipeline_id=pipeline_id, archived=False).count()
            new_weld = Weld(
                pipeline_id=pipeline_id,
                weld_no=str(weld_count + 1),
                between_a=m.position,
                between_b=connected.position,
            )
            db.session.add(new_weld)


def _renumber_positions(pipeline_id):
    """Renumber positions sequentially after a deletion."""
    mats = PipelineMaterial.query.filter_by(
        pipeline_id=pipeline_id, archived=False
    ).order_by(PipelineMaterial.position).all()
    for idx, m in enumerate(mats, 1):
        m.position = _pos_letter(idx)
    db.session.commit()


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
