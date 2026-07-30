from flask import Blueprint, request, jsonify
from app.database import db
from app.models.global_material import GlobalMaterial

global_materials_bp = Blueprint("global_materials", __name__)


@global_materials_bp.route("", methods=["GET"])
def get_global_materials():
    archived = request.args.get("archived", "false").lower() == "true"
    rows = GlobalMaterial.query.filter_by(archived=archived).all()
    return jsonify([_serialize(m) for m in rows])


@global_materials_bp.route("/<int:gm_id>", methods=["GET"])
def get_global_material(gm_id):
    m = GlobalMaterial.query.get_or_404(gm_id)
    return jsonify(_serialize(m))


@global_materials_bp.route("", methods=["POST"])
def create_or_find_global_material():
    """Create a global material or return existing one if it matches all fields."""
    data = request.get_json()

    # Try to find an existing match
    existing = GlobalMaterial.query.filter_by(
        category=data.get("category", ""),
        material_code=data.get("materialCode", ""),
        dien_no=data.get("dienNo", ""),
        dn1=data.get("dn1", ""),
        dn2=data.get("dn2", ""),
        dn3=data.get("dn3", ""),
        diameter=data.get("diameter", ""),
        thickness=data.get("thickness", ""),
        item_description=data.get("itemDescription", ""),
        archived=False,
    ).first()

    if existing:
        # Update surface if provided
        if data.get("surface"):
            existing.surface = data["surface"]
            db.session.commit()
        return jsonify(_serialize(existing)), 200

    # Create new
    m = GlobalMaterial(
        category=data.get("category", ""),
        dn1=data.get("dn1", ""),
        dn2=data.get("dn2", ""),
        dn3=data.get("dn3", ""),
        dn4=data.get("dn4", ""),
        dn5=data.get("dn5", ""),
        dn6=data.get("dn6", ""),
        diameter=data.get("diameter", ""),
        thickness=data.get("thickness", ""),
        item_description=data.get("itemDescription", ""),
        material_code=data.get("materialCode", ""),
        dien_no=data.get("dienNo", ""),
    )
    db.session.add(m)
    db.session.commit()
    return jsonify(_serialize(m)), 201


@global_materials_bp.route("/<int:gm_id>", methods=["POST"])
def edit_global_material(gm_id):
    """Edit an existing global material."""
    m = GlobalMaterial.query.get_or_404(gm_id)
    data = request.get_json()
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
    if "archived" in data:
        m.archived = data["archived"]
    db.session.commit()
    return jsonify(_serialize(m)), 200


def _serialize(m):
    return {
        "id": m.id,
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
        "archived": m.archived,
    }
