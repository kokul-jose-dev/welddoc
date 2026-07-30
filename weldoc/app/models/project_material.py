from app.database import db


class ProjectMaterial(db.Model):
    __tablename__ = "weldoc_project_materials"

    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    project_id = db.Column(db.Integer, db.ForeignKey("weldoc_projects.id"), nullable=False)
    global_material_id = db.Column(db.Integer, db.ForeignKey("weldoc_global_materials.id"), nullable=False)
    certificate = db.Column(db.String(100))
    heat_no = db.Column(db.String(200))
    waz_pdf_url = db.Column(db.String(500))
    archived = db.Column(db.Boolean, default=False)

    global_material = db.relationship("GlobalMaterial", lazy="joined")
