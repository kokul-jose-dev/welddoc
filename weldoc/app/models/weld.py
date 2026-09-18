from app.database import db


class Weld(db.Model):
    __tablename__ = "weldoc_welds"
    __table_args__ = (
        db.Index("ix_welds_pipeline_archived", "pipeline_id", "archived"),
    )

    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    pipeline_id = db.Column(db.Integer, db.ForeignKey("weldoc_pipelines.id"), nullable=False)
    weld_no = db.Column(db.String(20))
    between_a = db.Column(db.String(5))
    between_b = db.Column(db.String(5))
    type = db.Column(db.String(10))
    procedure = db.Column(db.String(50))
    welding_wire = db.Column(db.String(200))
    welder = db.Column(db.String(200))
    inspector = db.Column(db.String(200))
    welder_id = db.Column(db.Integer, db.ForeignKey("weldoc_welders.id"), nullable=True)
    inspector_id = db.Column(db.Integer, db.ForeignKey("weldoc_welders.id"), nullable=True)
    date = db.Column(db.String(20))
    visual = db.Column(db.String(20))
    endoscopy = db.Column(db.String(20))
    endoscopy_video_url = db.Column(db.String(500))
    endoscopy_image_url = db.Column(db.String(500))
    remarks = db.Column(db.Text)
    archived = db.Column(db.Boolean, default=False)
