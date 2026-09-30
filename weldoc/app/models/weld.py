from app.database import db
from app.spec_values import WholeNumberColumn, DateColumn


class Weld(db.Model):
    __tablename__ = "weldoc_welds"
    __table_args__ = (
        db.Index("ix_welds_pipeline_archived", "pipeline_id", "archived"),
    )

    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    pipeline_id = db.Column(db.Integer, db.ForeignKey("weldoc_pipelines.id"), nullable=False)
    weld_no = db.Column(WholeNumberColumn(20, label="Weld number"))
    # The two materials the weld joins (db/migrations/009). These are what the weld belongs
    # to; between_a / between_b are only their current position letters, kept up to date as
    # labels (_refresh_weld_labels). A weld without ids has not been matched yet ("needs
    # checking") and is handled by its letters as before.
    material_a_id = db.Column(db.Integer, nullable=True)
    material_b_id = db.Column(db.Integer, nullable=True)
    between_a = db.Column(db.String(5))
    between_b = db.Column(db.String(5))
    type = db.Column(db.String(10))
    procedure = db.Column(WholeNumberColumn(50, label="Welding procedure"))
    welding_wire = db.Column(db.String(200))
    welder = db.Column(db.String(200))
    inspector = db.Column(db.String(200))
    welder_id = db.Column(db.Integer, db.ForeignKey("weldoc_welders.id"), nullable=True)
    inspector_id = db.Column(db.Integer, db.ForeignKey("weldoc_welders.id"), nullable=True)
    date = db.Column(DateColumn(20, label="Weld date"))
    visual = db.Column(db.String(20))
    endoscopy = db.Column(db.String(20))
    endoscopy_video_url = db.Column(db.String(500))
    endoscopy_image_url = db.Column(db.String(500))
    remarks = db.Column(db.Text)
    archived = db.Column(db.Boolean, default=False)
    # Archiving after welding (migration 011): who, when, why - and "struck": the row stays in
    # the lists, struck through, instead of being hidden. A struck row is always archived.
    archived_at = db.Column(db.DateTime, nullable=True)
    archived_by = db.Column(db.Unicode(255), nullable=True)
    archive_reason = db.Column(db.Unicode(1000), nullable=True)
    struck = db.Column(db.Boolean, nullable=False, default=False)
