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
    m = PipelineMaterial.query.get_or_404(pm_id)
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

    # Handle connections
    if "connections" in data:
        _update_connections(m, data["connections"], pipeline_id)
        db.session.commit()
    else:
        # Auto-connect to previous material (chain: A→B→C→D)
        prev = PipelineMaterial.query.filter_by(
            pipeline_id=pipeline_id, archived=False
        ).filter(PipelineMaterial.id != m.id).order_by(
            PipelineMaterial.position.desc()
        ).first()
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

    # Update project material certificate/heat if provided
    pm = m.project_material
    pm_changed = False
    if "certificate" in data and data["certificate"]:
        pm.certificate = data["certificate"]
        pm_changed = True
    if "heatNo" in data and data["heatNo"]:
        pm.heat_no = data["heatNo"]
        pm_changed = True
    if "wazPdfUrl" in data:
        pm.waz_pdf_url = data["wazPdfUrl"]
        pm_changed = True

    # Auto-assign WAZ number if certificate + heat are now filled and waz_no is empty
    if pm_changed and pm.certificate and pm.heat_no and not m.waz_no:
        m.waz_no = _assign_waz_no(m.pipeline_id, m.project_material_id)
        # Also update other pipeline materials with same project_material_id
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
    """Upload WAZ document — saves to the project material."""
    from app.models.project import Project
    from app.sharepoint import upload_waz_to_project_folder

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

    url = upload_waz_to_project_folder(
        project.sharepoint_drive_id,
        project.sharepoint_folder_id,
        pm.heat_no or "unknown", pm.certificate or "unknown",
        file_content, content_type
    )

    if url:
        pm.waz_pdf_url = url
        if not m.waz_no and pm.certificate and pm.heat_no:
            m.waz_no = _assign_waz_no(m.pipeline_id, m.project_material_id)
        db.session.commit()
        return jsonify(_serialize(m)), 200
    else:
        return jsonify({"error": "Failed to upload to SharePoint"}), 500


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

    all_mats = {m.id: m for m in PipelineMaterial.query.filter_by(
        pipeline_id=pipeline_id, archived=False
    ).all()}

    # Update positions and flags, clear connections
    for item in items:
        m = all_mats.get(item["id"])
        if not m:
            continue
        m.position = item["position"]
        m.start_of_plumbing = item.get("startOfPlumbing", False)
        m.end_of_plumbing = item.get("endOfPlumbing", False)
        m.connections = []

    db.session.commit()

    # Delete all welds for this pipeline (they'll be recreated)
    Weld.query.filter_by(pipeline_id=pipeline_id, archived=False).delete()
    db.session.commit()

    # Rebuild connections and welds
    pos_to_mat = {m.position: m for m in all_mats.values()}
    weld_no = 1
    seen_pairs = set()

    for item in items:
        m = all_mats.get(item["id"])
        if not m:
            continue
        for conn_pos in item.get("connections", []):
            connected = pos_to_mat.get(conn_pos)
            if not connected or connected.id == m.id:
                continue
            # Add bidirectional connection
            if connected not in m.connections:
                m.connections.append(connected)
            if m not in connected.connections:
                connected.connections.append(m)

            # Create weld for unique pairs
            pair = tuple(sorted([m.position, conn_pos]))
            if pair not in seen_pairs:
                seen_pairs.add(pair)
                new_weld = Weld(
                    pipeline_id=pipeline_id,
                    weld_no=str(weld_no),
                    between_a=pair[0],
                    between_b=pair[1],
                )
                db.session.add(new_weld)
                weld_no += 1

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


def _update_connections(m, conn_positions, pipeline_id):
    """Update connections for a pipeline material by position letters."""
    # Get old connections
    old_positions = [c.position for c in m.connections]
    removed = [p for p in old_positions if p not in conn_positions]

    # Delete welds for removed connections
    for pos in removed:
        Weld.query.filter_by(pipeline_id=pipeline_id, archived=False).filter(
            db.or_(
                db.and_(Weld.between_a == m.position, Weld.between_b == pos),
                db.and_(Weld.between_a == pos, Weld.between_b == m.position),
            )
        ).delete(synchronize_session=False)

        # Remove reciprocal
        other = PipelineMaterial.query.filter_by(
            pipeline_id=pipeline_id, position=pos, archived=False
        ).first()
        if other and m in other.connections:
            other.connections.remove(m)

    # Rebuild connections
    m.connections = []
    for pos in conn_positions:
        connected = PipelineMaterial.query.filter_by(
            pipeline_id=pipeline_id, position=pos, archived=False
        ).first()
        if not connected or connected.id == m.id:
            continue
        if connected not in m.connections:
            m.connections.append(connected)
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
        "archived": m.archived,
        "connections": [c.id for c in m.connections],
        # Project material fields
        "certificate": pm.certificate if pm else None,
        "heatNo": pm.heat_no if pm else None,
        "wazPdfUrl": pm.waz_pdf_url if pm else None,
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
