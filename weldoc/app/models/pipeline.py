from app.database import db


class Pipeline(db.Model):
    __tablename__ = "weldoc_pipelines"

    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    project_id = db.Column(db.Integer, db.ForeignKey("weldoc_projects.id"), nullable=False)
    no = db.Column(db.String(100), nullable=False)
    plant = db.Column(db.String(50))
    status = db.Column(db.Integer, default=0)
    doc_iso = db.Column(db.String(500))
    doc_builder = db.Column(db.String(500))
    doc_final = db.Column(db.String(500))
    archived = db.Column(db.Boolean, default=False)

    materials = db.relationship("PipelineMaterial", backref="pipeline", lazy=True)
    welds = db.relationship("Weld", backref="pipeline", lazy=True)
