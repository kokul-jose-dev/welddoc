from flask import Blueprint, request, jsonify
from app.database import db
from app.models.weld import Weld

welds_bp = Blueprint("welds", __name__)


@welds_bp.route("", methods=["GET"])
def get_welds():
    pipeline_id = request.args.get("pipelineId", type=int)
    archived = request.args.get("archived", "false").lower() == "true"
    query = Weld.query.filter_by(archived=archived)
    if pipeline_id:
        query = query.filter_by(pipeline_id=pipeline_id)
    rows = query.all()
    return jsonify([_serialize(w) for w in rows])


@welds_bp.route("/<int:weld_id>", methods=["GET"])
def get_weld(weld_id):
    w = Weld.query.get_or_404(weld_id)
    return jsonify(_serialize(w))


@welds_bp.route("", methods=["POST"])
def create_or_update_weld():
    data = request.get_json()
    if "id" in data and data["id"]:
        w = Weld.query.get_or_404(data["id"])
        _update(w, data)
    else:
        # Check if weld with same pipeline_id + weld_no already exists
        existing = None
        if "pipelineId" in data and "weldNo" in data:
            existing = Weld.query.filter_by(
                pipeline_id=data["pipelineId"],
                weld_no=data["weldNo"],
                archived=False,
            ).first()
        if existing:
            w = existing
            _update(w, data)
        else:
            w = Weld(pipeline_id=data["pipelineId"])
            _update(w, data)
            db.session.add(w)
    db.session.commit()

    # Copy welder/inspector certificates to pipeline folder in background
    if data.get("welderId") or data.get("inspectorId"):
        import threading
        from flask import current_app
        app = current_app._get_current_object()
        weld_id = w.id
        def _bg_copy_certs():
            with app.app_context():
                _copy_welder_certs_to_pipeline(weld_id)
        threading.Thread(target=_bg_copy_certs, daemon=True).start()

    return jsonify(_serialize(w)), 200


@welds_bp.route("/<int:weld_id>/upload-files", methods=["POST"])
def upload_weld_files(weld_id):
    """Upload endo video and/or image to SharePoint in pipeline/Welds/ folder."""
    from app.models.pipeline import Pipeline
    from app.models.project import Project
    from app.sharepoint import upload_to_pipeline_subfolder

    w = Weld.query.get_or_404(weld_id)
    pipeline = Pipeline.query.get(w.pipeline_id)
    project = Project.query.get(pipeline.project_id)
    if not project.sharepoint_drive_id or not project.sharepoint_folder_id:
        return jsonify({"error": "No SharePoint folder configured for this project."}), 400

    weld_label = w.weld_no or str(w.id)

    if "video" in request.files and request.files["video"].filename:
        f = request.files["video"]
        ext = f.filename.rsplit(".", 1)[-1] if "." in f.filename else "mp4"
        name = f"Naht_{weld_label}.{ext}"
        url = upload_to_pipeline_subfolder(
            project.sharepoint_drive_id, project.sharepoint_folder_id,
            pipeline.no, "Welds", name, f.read(), f.content_type or "video/mp4"
        )
        if url:
            w.endoscopy_video_url = url

    if "image" in request.files and request.files["image"].filename:
        f = request.files["image"]
        ext = f.filename.rsplit(".", 1)[-1] if "." in f.filename else "jpg"
        name = f"Naht_{weld_label}.{ext}"
        url = upload_to_pipeline_subfolder(
            project.sharepoint_drive_id, project.sharepoint_folder_id,
            pipeline.no, "Welds", name, f.read(), f.content_type or "image/jpeg"
        )
        if url:
            w.endoscopy_image_url = url

    db.session.commit()
    return jsonify(_serialize(w)), 200


def _update(w, data):
    w.pipeline_id = data.get("pipelineId", w.pipeline_id)
    w.weld_no = data.get("weldNo", w.weld_no)
    w.between_a = data.get("betweenA", w.between_a)
    w.between_b = data.get("betweenB", w.between_b)
    w.type = data.get("type", w.type)
    w.procedure = data.get("procedure", w.procedure)
    w.welding_wire = data.get("weldingWire", w.welding_wire)
    if "welderId" in data:
        w.welder_id = data["welderId"] or None
    if "inspectorId" in data:
        w.inspector_id = data["inspectorId"] or None
    # Keep legacy string fields in sync
    if "welder" in data:
        w.welder = data["welder"]
    if "inspector" in data:
        w.inspector = data["inspector"]
    w.date = data.get("date", w.date)
    w.endoscopy_video_url = data.get("endoscopyVideoUrl", w.endoscopy_video_url)
    w.endoscopy_image_url = data.get("endoscopyImageUrl", w.endoscopy_image_url)
    w.remarks = data.get("remarks", w.remarks)
    if "archived" in data:
        w.archived = data["archived"]


def _serialize(w):
    return {
        "id": w.id,
        "pipelineId": w.pipeline_id,
        "weldNo": w.weld_no,
        "betweenA": w.between_a,
        "betweenB": w.between_b,
        "type": w.type,
        "procedure": w.procedure,
        "weldingWire": w.welding_wire,
        "welder": w.welder,
        "inspector": w.inspector,
        "welderId": w.welder_id,
        "inspectorId": w.inspector_id,
        "date": w.date,
        "endoscopyVideoUrl": w.endoscopy_video_url,
        "endoscopyImageUrl": w.endoscopy_image_url,
        "remarks": w.remarks,
        "archived": w.archived,
    }


def _copy_welder_certs_to_pipeline(weld_id):
    """Copy welder/inspector certificates to {pipeline}/Welders/ if not already there."""
    from app.models.pipeline import Pipeline
    from app.models.project import Project
    from app.models.welder import Welder, Certificate
    from app.sharepoint import upload_to_pipeline_subfolder, _download_sharepoint_file_content
    import logging

    w = Weld.query.get(weld_id)
    if not w:
        return
    pipeline = Pipeline.query.get(w.pipeline_id)
    if not pipeline:
        return
    project = Project.query.get(pipeline.project_id)
    if not project or not project.sharepoint_drive_id or not project.sharepoint_folder_id:
        return

    # Check which persons already have certs copied to each folder
    existing_welds = Weld.query.filter_by(pipeline_id=w.pipeline_id, archived=False).all()
    already_in_welders = set()
    already_in_inspectors = set()
    for ew in existing_welds:
        if ew.id == w.id:
            continue
        if ew.welder_id:
            already_in_welders.add(ew.welder_id)
        if ew.inspector_id:
            already_in_inspectors.add(ew.inspector_id)

    def _copy_certs(person_id, folder_name, already_set):
        if not person_id or person_id in already_set:
            return
        welder = Welder.query.get(person_id)
        if not welder:
            return
        certs = Certificate.query.filter_by(welder_id=person_id, archived=False).all()
        for c in certs:
            if not c.pdf_url:
                continue
            try:
                content = _download_sharepoint_file_content(c.pdf_url)
                if not content:
                    continue
                file_name = f"{welder.no}_{c.cert_no}.pdf"
                upload_to_pipeline_subfolder(
                    project.sharepoint_drive_id, project.sharepoint_folder_id,
                    pipeline.no, folder_name, file_name, content, "application/pdf"
                )
            except Exception as e:
                logging.getLogger(__name__).error(f"Failed to copy cert to {folder_name}: {e}")

    _copy_certs(w.welder_id, "Welders", already_in_welders)
    _copy_certs(w.inspector_id, "Inspectors", already_in_inspectors)
