from app.database import db


class WpsProcess(db.Model):
    __tablename__ = "weldoc_wps_processes"

    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    wps_no = db.Column(db.String(50), nullable=False, index=True)
    process = db.Column(db.String(50), nullable=False)
    archived = db.Column(db.Boolean, default=False)


DEFAULT_WPS_PROCESSES = [
    ("SP2", "141"),
    ("SP5", "135"),
    ("SP6", "136"),
    ("SP13", "141"),
    ("SP14", "147"),
    ("VP7", "135 / 136"),
    ("VP7", "135"),
    ("VP7", "136"),
    ("VP9", "141 / 136"),
    ("VP9", "141"),
    ("VP9", "136"),
    ("VP11", "145"),
    ("VP14", "142"),
    ("VP14.1", "142"),
    ("VP15", "141"),
    ("VP16.1", "141"),
    ("VP17", "141"),
    ("VP18", "136"),
    ("VP21", "145"),
]


_seeded = False


def seed_wps_processes():
    """Seed default WPS No. and Qualified Process combinations once in bulk."""
    global _seeded
    if _seeded:
        return
    try:
        existing_rows = WpsProcess.query.all()
        existing_set = {(r.wps_no.lower().strip(), r.process.lower().strip()) for r in existing_rows}
        to_add = []
        for wps_no, proc in DEFAULT_WPS_PROCESSES:
            key = (wps_no.lower().strip(), proc.lower().strip())
            if key not in existing_set:
                to_add.append(WpsProcess(wps_no=wps_no, process=proc))
                existing_set.add(key)
        if to_add:
            db.session.add_all(to_add)
            db.session.commit()
        _seeded = True
    except Exception as e:
        db.session.rollback()

