from app.database import db
from app.spec_values import DnColumn, DiameterColumn, ThicknessColumn, SurfaceColumn, MaterialCodeColumn


class GlobalMaterial(db.Model):
    """The specification catalogue.

    DN, diameter, thickness, surface and material code hold only the number in the database;
    reading them gives the display form ("DN 25", "33.7", "2.0 mm", "Ra 0.6 µm", "1.4404")
    and writing accepts the number with or without its unit. See app/spec_values.py.
    """

    __tablename__ = "weldoc_global_materials"

    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    category = db.Column(db.String(100))
    dn1 = db.Column(DnColumn(50))
    dn2 = db.Column(DnColumn(50))
    dn3 = db.Column(DnColumn(50))
    dn4 = db.Column(DnColumn(50))
    dn5 = db.Column(DnColumn(50))
    dn6 = db.Column(DnColumn(50))
    diameter = db.Column(DiameterColumn(50))
    diameter2 = db.Column(DiameterColumn(50))
    diameter3 = db.Column(DiameterColumn(50))
    thickness = db.Column(ThicknessColumn(50))
    thickness2 = db.Column(ThicknessColumn(50))
    thickness3 = db.Column(ThicknessColumn(50))
    surface = db.Column(SurfaceColumn(100))
    item_description = db.Column(db.String(300))
    material_code = db.Column(MaterialCodeColumn(50))
    dien_no = db.Column(db.String(100))
    archived = db.Column(db.Boolean, default=False)
