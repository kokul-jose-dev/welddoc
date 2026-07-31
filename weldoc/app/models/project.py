from app.database import db


class Project(db.Model):
    __tablename__ = "weldoc_projects"

    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    client_id = db.Column(db.Integer, db.ForeignKey("weldoc_clients.id"), nullable=False)
    ist_project_no = db.Column(db.String(100), nullable=False)
    title = db.Column(db.String(300))
    location = db.Column(db.String(200))
    order_no = db.Column(db.String(100))
    description = db.Column(db.Text)
    status = db.Column(db.String(50), default="Not started")
    archived = db.Column(db.Boolean, default=False)
    sharepoint_drive_id = db.Column(db.String(500))
    sharepoint_folder_id = db.Column(db.String(500))
    sharepoint_folder_url = db.Column(db.String(1000))

    pipelines = db.relationship("Pipeline", backref="project", lazy=True)
