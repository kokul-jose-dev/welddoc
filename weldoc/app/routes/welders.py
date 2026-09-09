from flask import Blueprint, request, jsonify
from app.database import db
from app.models.welder import Welder, Certificate

welders_bp = Blueprint("welders", __name__)

# --- Signature image spec -----------------------------------------------------
# The PDF prints the signature into a fixed landscape cell, so an off-ratio image
# either gets crushed or leaves the cell half empty. Uploads must therefore match
# the 3:1 shape the cell is built for.
SIG_ASPECT = 3.0            # width : height
SIG_ASPECT_TOL = 0.10       # ±10%
SIG_MIN_W, SIG_MIN_H = 300, 100
SIG_MAX_W, SIG_MAX_H = 1500, 500
SIG_FORMATS = ("PNG",)


def _validate_signature(file_content):
    """Return (ok, error_message, (w, h)). Enforces the format/resolution spec."""
    try:
        from PIL import Image
        import io as _io
        img = Image.open(_io.BytesIO(file_content))
        img.load()
    except Exception:
        return False, "This file could not be read as an image.", None

    fmt = (img.format or "").upper()
    w, h = img.size
    if fmt not in SIG_FORMATS:
        return False, (f"The signature must be a PNG file "
                       f"(this file is {fmt or 'of an unrecognised format'})."), (w, h)
    if h == 0:
        return False, "This image has no height.", (w, h)
    if w < SIG_MIN_W or h < SIG_MIN_H:
        return False, (f"Image is below the minimum size ({w} × {h} px). "
                       f"The minimum is {SIG_MIN_W} × {SIG_MIN_H} px."), (w, h)
    if w > SIG_MAX_W or h > SIG_MAX_H:
        return False, (f"Image exceeds the maximum size ({w} × {h} px). "
                       f"The maximum is {SIG_MAX_W} × {SIG_MAX_H} px."), (w, h)

    aspect = w / float(h)
    lo = SIG_ASPECT * (1 - SIG_ASPECT_TOL)
    hi = SIG_ASPECT * (1 + SIG_ASPECT_TOL)
    if not (lo <= aspect <= hi):
        return False, (f"Incorrect proportions ({w} × {h} px). The width must be "
                       f"three times the height: for a height of {h} px, the width "
                       f"should be {int(h * SIG_ASPECT)} px "
                       f"({int(h * lo)}–{int(h * hi)} px accepted)."), (w, h)
    return True, None, (w, h)


@welders_bp.route("", methods=["GET"])
def get_welders():
    archived = request.args.get("archived", "false").lower() == "true"
    rows = Welder.query.options(db.joinedload(Welder.certificates)).filter_by(archived=archived).order_by(Welder.name).all()
    return jsonify([_serialize_welder(w) for w in rows])


@welders_bp.route("/<int:wid>", methods=["GET"])
def get_welder(wid):
    w = Welder.query.get_or_404(wid)
    return jsonify(_serialize_welder(w))


@welders_bp.route("", methods=["POST"])
def create_or_update_welder():
    data = request.get_json()
    if "id" in data and data["id"]:
        w = Welder.query.get_or_404(data["id"])
        w.name = data.get("name", w.name)
        w.no = data.get("no", w.no)
        if "signatureUrl" in data:
            new_sig = data["signatureUrl"] or ""
            if not new_sig and w.signature_url:
                from app.sharepoint import delete_welder_signature_file
                delete_welder_signature_file(w.signature_url)
                delete_welder_signature_file(f"{w.no or w.id}_signature.png")
            w.signature_url = new_sig
        if "archived" in data:
            w.archived = data["archived"]
    else:
        w = Welder(name=data["name"], no=data.get("no", ""), signature_url=data.get("signatureUrl", ""))
        db.session.add(w)
    db.session.commit()
    return jsonify(_serialize_welder(w)), 200


@welders_bp.route("/<int:wid>/upload-signature", methods=["POST"])
def upload_welder_signature_route(wid):
    w = Welder.query.get_or_404(wid)
    if "file" not in request.files:
        return jsonify({"error": "No file provided"}), 400
    file = request.files["file"]
    if not file.filename:
        return jsonify({"error": "Empty filename"}), 400

    file_content = file.read()

    ok, err, size = _validate_signature(file_content)
    if not ok:
        return jsonify({
            "error": err,
            "spec": {
                "format": "PNG",
                "aspect": "3:1 (±10%)",
                "minSize": f"{SIG_MIN_W}x{SIG_MIN_H}",
                "maxSize": f"{SIG_MAX_W}x{SIG_MAX_H}",
                "recommended": "300x100",
            },
            "received": f"{size[0]}x{size[1]}" if size else None,
        }), 400

    import time
    from app.sharepoint import upload_welder_signature, delete_welder_signature_file

    # Delete existing signature file from SharePoint if replacing
    if w.signature_url:
        delete_welder_signature_file(w.signature_url)
    delete_welder_signature_file(f"{w.no or w.id}_signature.png")

    # Use timestamped filename to prevent stale browser and CDN caching
    safe_name = f"{w.no or w.id}_signature_{int(time.time())}.png"

    web_url = upload_welder_signature(safe_name, file_content, "image/png")
    if not web_url:
        return jsonify({"error": "Failed to upload signature to SharePoint"}), 500

    w.signature_url = web_url
    db.session.commit()
    return jsonify({"signatureUrl": web_url, "size": f"{size[0]}x{size[1]}"}), 200


@welders_bp.route("/<int:wid>/signature", methods=["DELETE"])
def delete_welder_signature_route(wid):
    w = Welder.query.get_or_404(wid)
    if w.signature_url:
        from app.sharepoint import delete_welder_signature_file
        delete_welder_signature_file(w.signature_url)
        delete_welder_signature_file(f"{w.no or w.id}_signature.png")
        w.signature_url = ""
        db.session.commit()
    return jsonify({"ok": True, "signatureUrl": ""}), 200


@welders_bp.route("/<int:wid>", methods=["DELETE"])
def archive_welder(wid):
    w = Welder.query.get_or_404(wid)
    w.archived = True
    db.session.commit()
    return jsonify({"ok": True}), 200


# ---- Certificates ----

@welders_bp.route("/<int:wid>/certificates", methods=["GET"])
def get_certificates(wid):
    archived = request.args.get("archived", "false").lower() == "true"
    rows = Certificate.query.filter_by(welder_id=wid, archived=archived).all()
    return jsonify([_serialize_cert(c) for c in rows])


@welders_bp.route("/<int:wid>/certificates", methods=["POST"])
def create_certificate(wid):
    Welder.query.get_or_404(wid)
    data = request.get_json()
    c = Certificate(
        welder_id=wid,
        cert_no=data["certNo"],
        process=data.get("process", ""),
        standard=data.get("standard", ""),
        valid_until=data.get("validUntil", ""),
        renewal_due=data.get("renewalDue", ""),
        pdf_url=data.get("pdfUrl", ""),
    )
    db.session.add(c)
    db.session.commit()
    from app.routes.wps_processes import ensure_wps_process
    ensure_wps_process(c.cert_no, c.process)
    return jsonify(_serialize_cert(c)), 201


@welders_bp.route("/certificates/<int:cid>", methods=["POST"])
def update_certificate(cid):
    c = Certificate.query.get_or_404(cid)
    data = request.get_json()
    if "certNo" in data:
        c.cert_no = data["certNo"]
    if "process" in data:
        c.process = data["process"]
    if "standard" in data:
        c.standard = data["standard"]
    if "validUntil" in data:
        c.valid_until = data["validUntil"]
    if "renewalDue" in data:
        c.renewal_due = data["renewalDue"]
    if "pdfUrl" in data:
        new_pdf_url = data["pdfUrl"] or ""
        old_pdf_url = c.pdf_url
        if old_pdf_url and old_pdf_url != new_pdf_url and not data.get("archived"):
            from app.sharepoint import delete_sharepoint_file
            try:
                delete_sharepoint_file(old_pdf_url)
            except Exception as e:
                current_app.logger.warning(f"Could not delete old cert PDF {old_pdf_url}: {e}")
        c.pdf_url = new_pdf_url
    if "archived" in data:
        c.archived = data["archived"]
        if data["archived"] and c.pdf_url:
            # Move PDF to Archive subfolder in background
            import threading
            from flask import current_app
            app = current_app._get_current_object()
            cert_id = c.id
            def _bg_archive():
                with app.app_context():
                    _move_cert_to_archive(cert_id)
            threading.Thread(target=_bg_archive, daemon=True).start()
    db.session.commit()
    if not c.archived:
        from app.routes.wps_processes import ensure_wps_process
        ensure_wps_process(c.cert_no, c.process)
    return jsonify(_serialize_cert(c)), 200


@welders_bp.route("/certificates/<int:cid>/upload", methods=["POST"])
def upload_certificate_pdf(cid):
    """Upload certificate PDF to SharePoint process folder."""
    from app.sharepoint import upload_welder_cert, delete_sharepoint_file

    c = Certificate.query.get_or_404(cid)
    w = Welder.query.get(c.welder_id)
    if not w:
        return jsonify({"error": "Welder not found"}), 404
    if "file" not in request.files:
        return jsonify({"error": "No file provided"}), 400
    file = request.files["file"]
    if not file.filename:
        return jsonify({"error": "Empty filename"}), 400

    file_content = file.read()
    content_type = file.content_type or "application/pdf"

    process = request.form.get("process") or c.process
    old_pdf_url = c.pdf_url

    url = upload_welder_cert(
        process=process,
        welder_name=w.name,
        welder_no=w.no,
        file_content=file_content,
        content_type=content_type,
    )
    if url:
        if old_pdf_url and old_pdf_url != url:
            try:
                delete_sharepoint_file(old_pdf_url)
            except Exception as e:
                current_app.logger.warning(f"Could not delete previous cert PDF {old_pdf_url}: {e}")
        c.pdf_url = url
        db.session.commit()
        return jsonify({"pdfUrl": url, "url": url}), 200
    else:
        return jsonify({"error": "Failed to upload to SharePoint"}), 500


def _serialize_welder(w):
    certs = [_serialize_cert(c) for c in w.certificates]
    procs = sorted(set(c.process for c in w.certificates if c.process and not c.archived))
    return {
        "id": w.id,
        "name": w.name,
        "no": w.no or "",
        "signatureUrl": w.signature_url or "",
        "procs": " / ".join(procs),
        "archived": w.archived,
        "certificates": certs,
    }


def _serialize_cert(c):
    return {
        "id": c.id,
        "welderId": c.welder_id,
        "certNo": c.cert_no,
        "process": c.process or "",
        "standard": c.standard or "",
        "validUntil": c.valid_until or "",
        "renewalDue": c.renewal_due or "",
        "pdfUrl": c.pdf_url or "",
        "archived": c.archived,
    }


def _move_cert_to_archive(cert_id):
    """Move an archived certificate PDF to 3.2_Personal & Ausbildung/Schweissprüfungen/{process}/_Archive/ in SharePoint."""
    from app.sharepoint import archive_welder_cert
    import logging

    c = Certificate.query.get(cert_id)
    if not c or not c.pdf_url:
        return
    w = Welder.query.get(c.welder_id)

    try:
        new_url = archive_welder_cert(
            pdf_url=c.pdf_url,
            process=c.process,
            welder_name=w.name if w else "Welder",
            welder_no=w.no if w else "",
            valid_until=c.valid_until,
        )
        if new_url:
            c.pdf_url = new_url
            db.session.commit()
    except Exception as e:
        logging.getLogger(__name__).error(f"SharePoint: Failed to archive cert {cert_id}: {e}")
