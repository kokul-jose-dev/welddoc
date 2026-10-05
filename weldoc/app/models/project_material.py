from app.spec_values import CertificateColumn
from sqlalchemy import event

from app.database import db


class ProjectMaterial(db.Model):
    __tablename__ = "weldoc_project_materials"
    __table_args__ = (
        db.Index("ix_projmat_project_archived", "project_id", "archived"),
        db.Index("ix_projmat_global", "global_material_id"),
    )

    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    project_id = db.Column(db.Integer, db.ForeignKey("weldoc_projects.id"), nullable=False)
    global_material_id = db.Column(db.Integer, db.ForeignKey("weldoc_global_materials.id"), nullable=False)
    certificate = db.Column(CertificateColumn(100))     # e.g. 3.1 (DECIMAL(3,1), migration 012)
    heat_no = db.Column(db.String(200))
    waz_pdf_url = db.Column(db.String(500))
    # The same certificate in the global WAZ folder (migration 013, app/global_waz.py)
    waz_global_url = db.Column(db.Unicode(500), nullable=True)
    archived = db.Column(db.Boolean, default=False)

    global_material = db.relationship("GlobalMaterial", lazy="joined")


@event.listens_for(ProjectMaterial.waz_pdf_url, "set")
def _certificate_removed(target, value, oldvalue, initiator):
    """No certificate any more -> no global copy of it either (on every path that clears it)."""
    if not value:
        target.waz_global_url = None
