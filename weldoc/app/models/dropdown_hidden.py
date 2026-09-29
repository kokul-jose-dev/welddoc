import datetime

from app.database import db

# The dropdown groups: DN 1-6 share one list, and so do diameter 1-3 and thickness 1-3.
DROPDOWN_TYPES = ("dn", "diameter", "thickness", "surface", "material_code", "dien_no")

# Global material column -> dropdown type
FIELD_TYPES = {
    **{f"dn{i}": "dn" for i in range(1, 7)},
    "diameter": "diameter", "diameter2": "diameter", "diameter3": "diameter",
    "thickness": "thickness", "thickness2": "thickness", "thickness3": "thickness",
    "surface": "surface", "material_code": "material_code", "dien_no": "dien_no",
}


class DropdownHidden(db.Model):
    """A dropdown value a user has hidden (db/migrations/008). Everything not listed here is
    offered as before; materials that already use a hidden value keep it."""

    __tablename__ = "weldoc_dropdown_hidden"
    __table_args__ = (db.UniqueConstraint("type", "value", name="UQ_weldoc_dropdown_hidden_type_value"),)

    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    type = db.Column(db.Unicode(30), nullable=False)
    value = db.Column(db.Unicode(200), nullable=False)
    hidden_by = db.Column(db.Unicode(200))
    hidden_at = db.Column(db.DateTime, nullable=False, default=datetime.datetime.utcnow)
