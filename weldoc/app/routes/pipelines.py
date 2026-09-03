from flask import Blueprint, request, jsonify
from app.database import db
from app.models.pipeline import Pipeline

pipelines_bp = Blueprint("pipelines", __name__)


@pipelines_bp.route("", methods=["GET"])
def get_pipelines():
    archived = request.args.get("archived", "false").lower() == "true"
    project_id = request.args.get("projectId", type=int)
    query = Pipeline.query.filter_by(archived=archived)
    if project_id:
        query = query.filter_by(project_id=project_id)
    rows = query.all()
    return jsonify([_serialize(p) for p in rows])


@pipelines_bp.route("/<int:pipeline_id>", methods=["GET"])
def get_pipeline(pipeline_id):
    p = Pipeline.query.get_or_404(pipeline_id)
    return jsonify(_serialize(p))


@pipelines_bp.route("", methods=["POST"])
def create_or_update_pipeline():
    data = request.get_json()
    if "id" in data and data["id"]:
        p = Pipeline.query.get_or_404(data["id"])
        p.project_id = data.get("projectId", p.project_id)
        p.no = data.get("no", p.no)
        p.plant = data.get("plant", p.plant)
        p.status = data.get("status", p.status)
        p.doc_iso = data.get("docIso", p.doc_iso)
        p.doc_builder = data.get("docBuilder", p.doc_builder)
        p.doc_final = data.get("docFinal", p.doc_final)
        if "weldingStart" in data:
            p.welding_start = data["weldingStart"]
        if "weldingEnd" in data:
            p.welding_end = data["weldingEnd"]
        if "weldingRemarks" in data:
            p.welding_remarks = data["weldingRemarks"]
        if "archived" in data:
            p.archived = data["archived"]
    else:
        p = Pipeline(
            project_id=data["projectId"],
            no=data["no"],
            plant=data.get("plant", ""),
            status=data.get("status", 0),
        )
        db.session.add(p)
    db.session.commit()
    return jsonify(_serialize(p)), 200


def _serialize(p):
    return {
        "id": p.id,
        "projectId": p.project_id,
        "no": p.no,
        "plant": p.plant,
        "status": p.status,
        "docIso": p.doc_iso,
        "docBuilder": p.doc_builder,
        "docFinal": p.doc_final,
        "weldingStart": p.welding_start,
        "weldingEnd": p.welding_end,
        "weldingRemarks": p.welding_remarks,
        "archived": p.archived,
    }


@pipelines_bp.route("/<int:pipeline_id>/upload-iso", methods=["POST"])
def upload_iso(pipeline_id):
    """Upload ISO document to SharePoint at {project_folder}/{pipeline_no}/ISO/"""
    from app.models.project import Project
    from app.sharepoint import upload_to_pipeline_subfolder

    p = Pipeline.query.get_or_404(pipeline_id)
    project = Project.query.get(p.project_id)
    if not project or not project.sharepoint_drive_id or not project.sharepoint_folder_id:
        return jsonify({"error": "No SharePoint folder configured for this project."}), 400

    if "file" not in request.files:
        return jsonify({"error": "No file provided"}), 400
    file = request.files["file"]
    if not file.filename:
        return jsonify({"error": "Empty filename"}), 400

    file_content = file.read()
    content_type = file.content_type or "application/pdf"

    try:
        web_url = upload_to_pipeline_subfolder(
            project.sharepoint_drive_id,
            project.sharepoint_folder_id,
            p.no,
            "ISO",
            file.filename,
            file_content,
            content_type
        )
        if not web_url:
            return jsonify({"error": "Failed to upload file to SharePoint."}), 500
        p.doc_iso = web_url
        db.session.commit()
        return jsonify({"docIso": web_url, "status": p.status}), 200
    except Exception as e:
        return jsonify({"error": f"Upload failed: {e}"}), 500
