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
        surface=data.get("surface", ""),
        archived=False,
    ).first()

    if existing:
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
        surface=data.get("surface", ""),
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


@global_materials_bp.route("/update-spec", methods=["POST"])
def update_global_material_spec():
    """Update global material specification, matching by globalMaterialId or original spec."""
    data = request.get_json() or {}
    gm_id = data.get("globalMaterialId") or data.get("gmId")
    original = data.get("original") or {}

    gm = None
    if gm_id:
        gm = GlobalMaterial.query.get(gm_id)

    if not gm and original:
        orig_cat = original.get("piece") or original.get("category") or ""
        orig_desc = original.get("itemDescription") or ""
        orig_dn1 = original.get("dimension") or original.get("dn1") or ""
        orig_dien = original.get("dienNo") or ""
        orig_code = original.get("materialCode") or ""
        query = GlobalMaterial.query.filter_by(category=orig_cat, archived=False)
        if orig_desc:
            query = query.filter_by(item_description=orig_desc)
        if orig_dn1:
            query = query.filter_by(dn1=orig_dn1)
        if orig_dien:
            query = query.filter_by(dien_no=orig_dien)
        if orig_code:
            query = query.filter_by(material_code=orig_code)
        gm = query.first()

    if not gm:
        # Create a new GlobalMaterial
        gm = GlobalMaterial(
            category=data.get("category") or data.get("piece") or "",
            item_description=data.get("itemDescription") or "",
            dn1=data.get("dn1") or data.get("dimension") or "",
            dn2=data.get("dn2") or data.get("dimension2") or "",
            dn3=data.get("dn3") or data.get("dimension3") or "",
            dn4=data.get("dn4") or data.get("dimension4") or "",
            dn5=data.get("dn5") or data.get("dimension5") or "",
            dn6=data.get("dn6") or data.get("dimension6") or "",
            diameter=data.get("diameter") or "",
            thickness=data.get("thickness") or "",
            surface=data.get("surface") or "",
            material_code=data.get("materialCode") or "",
            dien_no=data.get("dienNo") or "",
        )
        db.session.add(gm)
    else:
        # Update existing
        if "category" in data or "piece" in data:
            gm.category = data.get("category") or data.get("piece") or gm.category
        if "itemDescription" in data:
            gm.item_description = data.get("itemDescription") or gm.item_description
        if "dn1" in data or "dimension" in data:
            gm.dn1 = data.get("dn1") or data.get("dimension") or gm.dn1
        for i in range(2, 7):
            k = f"dn{i}"
            dk = f"dimension{i}"
            if k in data or dk in data:
                setattr(gm, k, data.get(k) or data.get(dk) or "")
        if "diameter" in data:
            gm.diameter = data.get("diameter") or ""
        if "thickness" in data:
            gm.thickness = data.get("thickness") or ""
        if "surface" in data:
            gm.surface = data.get("surface") or ""
        if "materialCode" in data:
            gm.material_code = data.get("materialCode") or gm.material_code
        if "dienNo" in data:
            gm.dien_no = data.get("dienNo") or gm.dien_no

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
        "thickness": m.thickness,
        "surface": m.surface,
        "itemDescription": m.item_description,
        "materialCode": m.material_code,
        "dienNo": m.dien_no,
        "archived": m.archived,
    }
