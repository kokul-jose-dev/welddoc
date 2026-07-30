from flask import Blueprint, request, jsonify
from app.database import db
from app.models.material import Material
from app.models.weld import Weld
from app.models.pipeline import Pipeline
from app.models.project import Project
from app.models.client import Client
from app.sharepoint import upload_waz_document

materials_bp = Blueprint("materials", __name__)


@materials_bp.route("", methods=["GET"])
def get_materials():
    pipeline_id = request.args.get("pipelineId", type=int)
    archived = request.args.get("archived", "false").lower() == "true"
    query = Material.query.filter_by(archived=archived)
    if pipeline_id:
        query = query.filter_by(pipeline_id=pipeline_id)
    rows = query.order_by(Material.position).all()
    return jsonify([_serialize(m) for m in rows])


@materials_bp.route("/<int:material_id>", methods=["GET"])
def get_material(material_id):
    m = Material.query.get_or_404(material_id)
    return jsonify(_serialize(m))


@materials_bp.route("", methods=["POST"])
def create_or_update_material():
    data = request.get_json()
    if "id" in data and data["id"]:
        m = Material.query.get_or_404(data["id"])
        _update(m, data)
    else:
        m = Material(pipeline_id=data["pipelineId"])
        _update(m, data)
        db.session.add(m)
    db.session.commit()

    # Handle connections by position letters
    if "connections" in data:
        pipeline_id = m.pipeline_id
        conn_positions = data["connections"]  # e.g. ["A", "C"]

        # Get OLD connections before clearing
        old_connected_positions = [c.position for c in m.connections]

        # Find which connections were REMOVED
        removed_positions = [p for p in old_connected_positions if p not in conn_positions]

        # Delete welds for removed connections
        for pos in removed_positions:
            weld_to_delete = Weld.query.filter_by(
                pipeline_id=pipeline_id, archived=False
            ).filter(
                db.or_(
                    db.and_(Weld.between_a == m.position, Weld.between_b == pos),
                    db.and_(Weld.between_a == pos, Weld.between_b == m.position),
                )
            ).first()
            if weld_to_delete:
                db.session.delete(weld_to_delete)

            # Also remove reciprocal connection from the other material
            other = Material.query.filter_by(
                pipeline_id=pipeline_id, position=pos, archived=False
            ).first()
            if other and m in other.connections:
                other.connections.remove(m)

        # Clear and rebuild connections
        m.connections = []
        db.session.commit()

        for pos in conn_positions:
            # Find material at this position in the same pipeline
            connected = Material.query.filter_by(
                pipeline_id=pipeline_id, position=pos, archived=False
            ).first()
            if not connected or connected.id == m.id:
                continue

            # Add bidirectional connection
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
                # Count existing welds to determine weld_no
                weld_count = Weld.query.filter_by(
                    pipeline_id=pipeline_id, archived=False
                ).count()
                new_weld = Weld(
                    pipeline_id=pipeline_id,
                    weld_no=str(weld_count + 1),
                    between_a=m.position,
                    between_b=connected.position,
                )
                db.session.add(new_weld)

        db.session.commit()

        # Renumber welds sequentially
        all_welds = Weld.query.filter_by(
            pipeline_id=pipeline_id, archived=False
        ).order_by(Weld.id).all()
        for idx, w in enumerate(all_welds, 1):
            w.weld_no = str(idx)
        db.session.commit()

    return jsonify(_serialize(m)), 200


def _update(m, data):
    m.pipeline_id = data.get("pipelineId", m.pipeline_id)
    m.position = data.get("position", m.position)
    m.category = data.get("category", m.category)
    m.dn1 = data.get("dn1", m.dn1)
    m.dn2 = data.get("dn2", m.dn2)
    m.dn3 = data.get("dn3", m.dn3)
    m.dn4 = data.get("dn4", m.dn4)
    m.dn5 = data.get("dn5", m.dn5)
    m.dn6 = data.get("dn6", m.dn6)
    m.diameter = data.get("diameter", m.diameter)
    m.thickness = data.get("thickness", m.thickness)
    m.surface = data.get("surface", m.surface)
    m.item_description = data.get("itemDescription", m.item_description)
    m.material_code = data.get("materialCode", m.material_code)
    m.dien_no = data.get("dienNo", m.dien_no)
    m.certificate = data.get("certificate", m.certificate)
    m.heat_no = data.get("heatNo", m.heat_no)
    m.waz_no = data.get("wazNo", m.waz_no)
    m.waz_pdf_url = data.get("wazPdfUrl", m.waz_pdf_url)
    m.start_of_plumbing = data.get("startOfPlumbing", m.start_of_plumbing)
    m.end_of_plumbing = data.get("endOfPlumbing", m.end_of_plumbing)
    if "archived" in data:
        m.archived = data["archived"]


@materials_bp.route("/reorder", methods=["POST"])
def reorder_materials():
    """Bulk update positions, connections, start/end flags after drag & drop.
    Expects: { pipelineId, materials: [{id, position, connections:["B","D"], startOfPlumbing, endOfPlumbing}, ...] }
    """
    data = request.get_json()
    pipeline_id = data["pipelineId"]
    items = data["materials"]

    # Build a position→material lookup for this pipeline
    all_mats = {m.id: m for m in Material.query.filter_by(pipeline_id=pipeline_id, archived=False).all()}

    # Update positions, start/end flags, and clear connections
    for item in items:
        m = all_mats.get(item["id"])
        if not m:
            continue
        m.position = item["position"]
        m.start_of_plumbing = item.get("startOfPlumbing", False)
        m.end_of_plumbing = item.get("endOfPlumbing", False)
        m.connections = []

    db.session.commit()

    # Delete all welds for this pipeline (they'll be recreated from connections)
    Weld.query.filter_by(pipeline_id=pipeline_id, archived=False).delete()
    db.session.commit()

    # Rebuild connections and welds
    pos_to_mat = {}
    for m in all_mats.values():
        pos_to_mat[m.position] = m

    weld_no = 1
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

    db.session.commit()

    # Create welds for each unique connection pair
    seen_pairs = set()
    for item in items:
        m = all_mats.get(item["id"])
        if not m:
            continue
        for conn_pos in item.get("connections", []):
            pair = tuple(sorted([m.position, conn_pos]))
            if pair in seen_pairs:
                continue
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


@materials_bp.route("/<int:material_id>/upload-waz", methods=["POST"])
def upload_waz(material_id):
    """Upload a WAZ PDF document to SharePoint for a material."""
    m = Material.query.get_or_404(material_id)
    if "file" not in request.files:
        return jsonify({"error": "No file provided"}), 400

    file = request.files["file"]
    if not file.filename:
        return jsonify({"error": "Empty filename"}), 400

    # Get hierarchy info
    pipeline = Pipeline.query.get(m.pipeline_id)
    project = Project.query.get(pipeline.project_id)
    client = Client.query.get(project.client_id)

    heat_no = m.heat_no or "unknown"
    certificate_no = m.certificate or "unknown"

    file_content = file.read()
    content_type = file.content_type or "application/pdf"

    url = upload_waz_document(
        client.id, client.name,
        project.title or project.ist_project_no, project.ist_project_no,
        heat_no, certificate_no,
        file_content, content_type
    )

    if url:
        m.waz_pdf_url = url
        db.session.commit()
        return jsonify({"wazPdfUrl": url}), 200
    else:
        return jsonify({"error": "Failed to upload to SharePoint"}), 500


def _serialize(m):
    return {
        "id": m.id,
        "pipelineId": m.pipeline_id,
        "position": m.position,
        "category": m.category,
        "dn1": m.dn1,
        "dn2": m.dn2,
        "dn3": m.dn3,
        "dn4": m.dn4,
        "dn5": m.dn5,
        "dn6": m.dn6,
        "diameter": m.diameter,
        "thickness": m.thickness,
        "surface": m.surface,
        "itemDescription": m.item_description,
        "materialCode": m.material_code,
        "dienNo": m.dien_no,
        "certificate": m.certificate,
        "heatNo": m.heat_no,
        "wazNo": m.waz_no,
        "wazPdfUrl": m.waz_pdf_url,
        "startOfPlumbing": m.start_of_plumbing,
        "endOfPlumbing": m.end_of_plumbing,
        "archived": m.archived,
        "connections": [c.id for c in m.connections],
    }
