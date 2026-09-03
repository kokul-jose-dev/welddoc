from app.database import db


class Welder(db.Model):
    __tablename__ = "weldoc_welders"

    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    name = db.Column(db.String(200), nullable=False)
    no = db.Column(db.String(50))
    signature_url = db.Column(db.String(500), nullable=True)
    archived = db.Column(db.Boolean, default=False)

    certificates = db.relationship("Certificate", back_populates="welder", lazy="joined")


class Certificate(db.Model):
    __tablename__ = "weldoc_weldercertificate"

    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    welder_id = db.Column(db.Integer, db.ForeignKey("weldoc_welders.id"), nullable=False)
    cert_no = db.Column(db.String(100), nullable=False)
    process = db.Column(db.String(50))
    standard = db.Column(db.String(100))
    valid_until = db.Column(db.String(20))
    renewal_due = db.Column(db.String(20))
    pdf_url = db.Column(db.String(500))
    archived = db.Column(db.Boolean, default=False)

    welder = db.relationship("Welder", back_populates="certificates")
