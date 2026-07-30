from app.database import db


class GlobalMaterial(db.Model):
    __tablename__ = "weldoc_global_materials"

    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    category = db.Column(db.String(100))
    dn1 = db.Column(db.String(50))
    dn2 = db.Column(db.String(50))
    dn3 = db.Column(db.String(50))
    dn4 = db.Column(db.String(50))
    dn5 = db.Column(db.String(50))
    dn6 = db.Column(db.String(50))
    diameter = db.Column(db.String(50))
    thickness = db.Column(db.String(50))
    surface = db.Column(db.String(100))
    item_description = db.Column(db.String(300))
    material_code = db.Column(db.String(50))
    dien_no = db.Column(db.String(100))
    archived = db.Column(db.Boolean, default=False)
