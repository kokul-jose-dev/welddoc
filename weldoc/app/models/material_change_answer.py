from app.database import db


class MaterialChangeAnswer(db.Model):
    """What a pipe on final answered when a material it uses was changed everywhere afterwards
    (app/material_change.py): "apply" (switched to the newer material) or "keep" (not asked
    again for that newer material)."""
    __tablename__ = "weldoc_material_change_answers"

    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    pipeline_id = db.Column(db.Integer, db.ForeignKey("weldoc_pipelines.id"), nullable=False, index=True)
    project_material_id = db.Column(db.Integer, db.ForeignKey("weldoc_project_materials.id"), nullable=False)
    replacement_id = db.Column(db.Integer, db.ForeignKey("weldoc_project_materials.id"), nullable=False)
    answer = db.Column(db.String(10), nullable=False)
    answered_by = db.Column(db.Unicode(255))
    answered_at = db.Column(db.DateTime)
