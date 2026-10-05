"""Hide / show values in the material dropdowns (the x next to a dropdown).

    GET    /api/dropdown-hidden                    -> {"dn": ["DN 30"], "thickness": [...], ...}
    POST   /api/dropdown-hidden   {type, value}    -> hide it
    DELETE /api/dropdown-hidden   {type, value}    -> show it again

Values are stored in the form the dropdown shows ("DN 30", "2.0 mm", "Ra 0.6 µm", "1.4404"),
so "30", "DN30" and "DN 30" are the same hidden value.
"""

from flask import Blueprint, jsonify, request, session

from app.database import db
from app.models.dropdown_hidden import DropdownHidden, DROPDOWN_TYPES, FIELD_TYPES
from app.spec_values import canon_dn, canon_diameter, canon_thickness, canon_surface, canon_material_code

dropdown_values_bp = Blueprint("dropdown_values", __name__)

_CANON = {
    "dn": canon_dn, "diameter": canon_diameter, "thickness": canon_thickness,
    "surface": canon_surface, "material_code": canon_material_code,
    "dien_no": lambda v: str(v or "").strip(),
}


def canon_value(dd_type, value):
    """The value in its dropdown form. Raises SpecValueError (-> 400) for a non-number."""
    return _CANON[dd_type](value)


def hidden_map():
    out = {t: [] for t in DROPDOWN_TYPES}
    for row in DropdownHidden.query.order_by(DropdownHidden.type, DropdownHidden.value).all():
        out.setdefault(row.type, []).append(row.value)
    return out


def _read():
    data = request.get_json(silent=True) or {}
    dd_type = (data.get("type") or "").strip()
    if dd_type not in DROPDOWN_TYPES:
        return None, None, (jsonify({"error": "invalid_request", "message": "Unknown dropdown."}), 400)
    value = canon_value(dd_type, data.get("value"))
    if not value:
        return None, None, (jsonify({"error": "invalid_request", "message": "No value given."}), 400)
    return dd_type, value, None


@dropdown_values_bp.route("", methods=["GET"])
def list_hidden():
    return jsonify(hidden_map())


@dropdown_values_bp.route("", methods=["POST"])
def hide_value():
    dd_type, value, err = _read()
    if err:
        return err
    exists = DropdownHidden.query.filter(DropdownHidden.type == dd_type,
                                         db.func.lower(DropdownHidden.value) == value.lower()).first()
    if not exists:
        user = session.get("user") or {}
        db.session.add(DropdownHidden(type=dd_type, value=value,
                                      hidden_by=(user.get("email") or user.get("name") or "")[:200]))
        db.session.commit()
    return jsonify(hidden_map())


@dropdown_values_bp.route("", methods=["DELETE"])
def show_value():
    dd_type, value, err = _read()
    if err:
        return err
    for row in DropdownHidden.query.filter(DropdownHidden.type == dd_type,
                                           db.func.lower(DropdownHidden.value) == value.lower()).all():
        db.session.delete(row)          # one by one, so the event log records it
    db.session.commit()
    return jsonify(hidden_map())


def unhide_entered_values(new_norm, old=None):
    """Someone typed a hidden value in on purpose ("+ Other") - show it again.

    new_norm: the normalized global material values being saved (normalize_gm_data).
    old: the global material as it was before an edit, or None for a newly created one.
    Only values that are new or changed count: saving an old material that still carries a
    hidden value does not bring it back.
    """
    by_type = {}
    for field, dd_type in FIELD_TYPES.items():
        new = str(new_norm.get(field) or "").strip()
        if not new:
            continue
        before = str(getattr(old, field, "") or "").strip() if old is not None else ""
        if old is not None and before.lower() == new.lower():
            continue
        by_type.setdefault(dd_type, set()).add(new.lower())
    for dd_type, values in by_type.items():
        for row in DropdownHidden.query.filter(DropdownHidden.type == dd_type,
                                               db.func.lower(DropdownHidden.value).in_(values)).all():
            db.session.delete(row)      # one by one, so the event log records it
