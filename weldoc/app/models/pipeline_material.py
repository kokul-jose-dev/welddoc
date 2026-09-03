from app.database import db

pipeline_material_connections = db.Table(
    "weldoc_pipeline_material_connections",
    db.Column("pipeline_material_id", db.Integer, db.ForeignKey("weldoc_pipeline_materials.id")),
    db.Column("connected_id", db.Integer, db.ForeignKey("weldoc_pipeline_materials.id")),
)


class PipelineMaterial(db.Model):
    __tablename__ = "weldoc_pipeline_materials"
    __table_args__ = (
        db.Index("ix_plmat_pipeline_archived", "pipeline_id", "archived"),
        db.Index("ix_plmat_projmat", "project_material_id"),
    )

    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    pipeline_id = db.Column(db.Integer, db.ForeignKey("weldoc_pipelines.id"), nullable=False)
    project_material_id = db.Column(db.Integer, db.ForeignKey("weldoc_project_materials.id"), nullable=False)
    position = db.Column(db.String(5))
    waz_no = db.Column(db.String(50))
    waz_package_url = db.Column(db.String(500), nullable=True)
    start_of_plumbing = db.Column(db.Boolean, default=False)
    end_of_plumbing = db.Column(db.Boolean, default=False)
    archived = db.Column(db.Boolean, default=False)

    project_material = db.relationship("ProjectMaterial", lazy="joined")
    connections = db.relationship(
        "PipelineMaterial",
        secondary=pipeline_material_connections,
        primaryjoin=id == pipeline_material_connections.c.pipeline_material_id,
        secondaryjoin=id == pipeline_material_connections.c.connected_id,
        lazy="subquery",
    )
