from flask import Blueprint, request, jsonify
from app.database import db
from app.models.global_material import GlobalMaterial
from app.material_utils import (
    normalize_gm_data,
    find_matching_global_material,
    merge_global_materials,
)

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
    data = request.get_json() or {}
    norm = normalize_gm_data(data)

    existing = find_matching_global_material(norm)
    if existing:
        return jsonify(_serialize(existing)), 200

    # Create new
    m = GlobalMaterial(
        category=norm["category"],
        dn1=norm["dn1"],
        dn2=norm["dn2"],
        dn3=norm["dn3"],
        dn4=norm["dn4"],
        dn5=norm["dn5"],
        dn6=norm["dn6"],
        diameter=norm["diameter"],
        diameter2=norm["diameter2"],
        diameter3=norm["diameter3"],
        thickness=norm["thickness"],
        thickness2=norm["thickness2"],
        thickness3=norm["thickness3"],
        item_description=norm["item_description"],
        material_code=norm["material_code"],
        dien_no=norm["dien_no"],
        surface=norm["surface"],
    )
    db.session.add(m)
    db.session.commit()
    return jsonify(_serialize(m)), 201


@global_materials_bp.route("/<int:gm_id>", methods=["POST"])
def edit_global_material(gm_id):
    """Edit an existing global material with automatic deduplication/merge."""
    m = GlobalMaterial.query.get_or_404(gm_id)
    data = request.get_json() or {}

    current_dict = {
        "category": data.get("category", m.category),
        "dn1": data.get("dn1", m.dn1),
        "dn2": data.get("dn2", m.dn2),
        "dn3": data.get("dn3", m.dn3),
        "dn4": data.get("dn4", m.dn4),
        "dn5": data.get("dn5", m.dn5),
        "dn6": data.get("dn6", m.dn6),
        "diameter": data.get("diameter", m.diameter),
        "diameter2": data.get("diameter2", m.diameter2),
        "diameter3": data.get("diameter3", m.diameter3),
        "thickness": data.get("thickness", m.thickness),
        "thickness2": data.get("thickness2", m.thickness2),
        "thickness3": data.get("thickness3", m.thickness3),
        "surface": data.get("surface", m.surface),
        "itemDescription": data.get("itemDescription", m.item_description),
        "materialCode": data.get("materialCode", m.material_code),
        "dienNo": data.get("dienNo", m.dien_no),
    }
    norm = normalize_gm_data(current_dict)

    existing_other = find_matching_global_material(norm, exclude_id=gm_id)
    if existing_other:
        merge_global_materials(gm_id, existing_other.id)
        db.session.commit()
        return jsonify(_serialize(existing_other)), 200

    m.category = norm["category"]
    m.dn1 = norm["dn1"]
    m.dn2 = norm["dn2"]
    m.dn3 = norm["dn3"]
    m.dn4 = norm["dn4"]
    m.dn5 = norm["dn5"]
    m.dn6 = norm["dn6"]
    m.diameter = norm["diameter"]
    m.diameter2 = norm["diameter2"]
    m.diameter3 = norm["diameter3"]
    m.thickness = norm["thickness"]
    m.thickness2 = norm["thickness2"]
    m.thickness3 = norm["thickness3"]
    m.surface = norm["surface"]
    m.item_description = norm["item_description"]
    m.material_code = norm["material_code"]
    m.dien_no = norm["dien_no"]
    if "archived" in data:
        m.archived = data["archived"]

    db.session.commit()
    return jsonify(_serialize(m)), 200


@global_materials_bp.route("/update-spec", methods=["POST"])
def update_global_material_spec():
    """Update global material specification with auto-merge."""
    data = request.get_json() or {}
    gm_id = data.get("globalMaterialId") or data.get("gmId")
    norm = normalize_gm_data(data)

    gm = None
    if gm_id:
        gm = GlobalMaterial.query.get(gm_id)

    if not gm:
        existing = find_matching_global_material(norm)
        if existing:
            return jsonify(_serialize(existing)), 200

        gm = GlobalMaterial(
            category=norm["category"],
            item_description=norm["item_description"],
            dn1=norm["dn1"],
            dn2=norm["dn2"],
            dn3=norm["dn3"],
            dn4=norm["dn4"],
            dn5=norm["dn5"],
            dn6=norm["dn6"],
            diameter=norm["diameter"],
            diameter2=norm["diameter2"],
            diameter3=norm["diameter3"],
            thickness=norm["thickness"],
            thickness2=norm["thickness2"],
            thickness3=norm["thickness3"],
            surface=norm["surface"],
            material_code=norm["material_code"],
            dien_no=norm["dien_no"],
        )
        db.session.add(gm)
        db.session.commit()
        return jsonify(_serialize(gm)), 201
    else:
        existing_other = find_matching_global_material(norm, exclude_id=gm.id)
        if existing_other:
            merge_global_materials(gm.id, existing_other.id)
            db.session.commit()
            return jsonify(_serialize(existing_other)), 200

        gm.category = norm["category"]
        gm.item_description = norm["item_description"]
        gm.dn1 = norm["dn1"]
        gm.dn2 = norm["dn2"]
        gm.dn3 = norm["dn3"]
        gm.dn4 = norm["dn4"]
        gm.dn5 = norm["dn5"]
        gm.dn6 = norm["dn6"]
        gm.diameter = norm["diameter"]
        gm.diameter2 = norm["diameter2"]
        gm.diameter3 = norm["diameter3"]
        gm.thickness = norm["thickness"]
        gm.thickness2 = norm["thickness2"]
        gm.thickness3 = norm["thickness3"]
        gm.surface = norm["surface"]
        gm.material_code = norm["material_code"]
        gm.dien_no = norm["dien_no"]

        db.session.commit()
        return jsonify(_serialize(gm)), 200


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
        "diameter2": m.diameter2,
        "diameter3": m.diameter3,
        "thickness": m.thickness,
        "thickness2": m.thickness2,
        "thickness3": m.thickness3,
        "surface": m.surface,
        "itemDescription": m.item_description,
        "materialCode": m.material_code,
        "dienNo": m.dien_no,
        "archived": m.archived,
    }
