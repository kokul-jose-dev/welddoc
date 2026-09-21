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


@pipelines_bp.route("/check-no", methods=["GET"])
def check_pipeline_no():
    """Report whether a pipeline number is already in use.

    A repeat inside the same project is a real clash; the same number under another
    project is only worth mentioning, so the two are reported separately.
    """
    from app.models.project import Project

    no = (request.args.get("no") or "").strip()
    project_id = request.args.get("projectId", type=int)
    exclude_id = request.args.get("excludeId", type=int)
    if not no:
        return jsonify({"duplicate": False, "pipeline": None, "otherProjects": []})

    rows = Pipeline.query.filter(
        db.func.lower(db.func.ltrim(db.func.rtrim(Pipeline.no))) == no.lower(),
        Pipeline.archived == False,  # noqa: E712
    ).all()
    if exclude_id:
        rows = [r for r in rows if r.id != exclude_id]

    titles = {}
    for pr in Project.query.filter(Project.id.in_([r.project_id for r in rows] or [0])).all():
        titles[pr.id] = pr.title

    def brief(r):
        return {
            "id": r.id,
            "no": r.no,
            "projectId": r.project_id,
            "projectTitle": titles.get(r.project_id, ""),
        }

    same = [r for r in rows if project_id and r.project_id == project_id]
    other = [r for r in rows if not project_id or r.project_id != project_id]
    return jsonify({
        "duplicate": bool(same),
        "pipeline": brief(same[0]) if same else None,
        "otherProjects": [brief(r) for r in other],
    })


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
    """Upload or replace ISO document in SharePoint at {project_folder}/{pipeline_no}/01 Isometrie & Stückliste/
    Deletes any existing file in the ISO subfolder before uploading the new one."""
    from app.models.project import Project
    from app.sharepoint import upload_to_pipeline_subfolder, list_pipeline_subfolder_files, delete_sharepoint_drive_item, delete_sharepoint_file_by_url

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
        # Delete old files in the ISO subfolder if any exist
        existing_files = list_pipeline_subfolder_files(
            project.sharepoint_drive_id,
            project.sharepoint_folder_id,
            p.no,
            "01 Isometrie & Stückliste"
        )
        for item in existing_files:
            item_id = item.get("id")
            if item_id:
                delete_sharepoint_drive_item(project.sharepoint_drive_id, item_id)

        # Also try deleting old doc_iso url if recorded
        if p.doc_iso:
            try:
                delete_sharepoint_file_by_url(p.doc_iso)
            except Exception:
                pass

        web_url = upload_to_pipeline_subfolder(
            project.sharepoint_drive_id,
            project.sharepoint_folder_id,
            p.no,
            "01 Isometrie & Stückliste",
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


@pipelines_bp.route("/<int:pipeline_id>/delete-iso", methods=["POST", "DELETE"])
def delete_iso(pipeline_id):
    """Delete ISO document from SharePoint and clear p.doc_iso."""
    from app.models.project import Project
    from app.sharepoint import list_pipeline_subfolder_files, delete_sharepoint_drive_item, delete_sharepoint_file_by_url

    p = Pipeline.query.get_or_404(pipeline_id)
    project = Project.query.get(p.project_id)
    if project and project.sharepoint_drive_id and project.sharepoint_folder_id:
        existing_files = list_pipeline_subfolder_files(
            project.sharepoint_drive_id,
            project.sharepoint_folder_id,
            p.no,
            "01 Isometrie & Stückliste"
        )
        for item in existing_files:
            item_id = item.get("id")
            if item_id:
                delete_sharepoint_drive_item(project.sharepoint_drive_id, item_id)
        if p.doc_iso:
            try:
                delete_sharepoint_file_by_url(p.doc_iso)
            except Exception:
                pass

    p.doc_iso = None
    db.session.commit()
    return jsonify({"ok": True, "docIso": None}), 200


@pipelines_bp.route("/<int:pipeline_id>/regenerate-waz", methods=["POST"])
def regenerate_pipeline_waz(pipeline_id):
    """Regenerate all WAZ cover sheets and merged packages with current details for this pipeline,
    and remove any old, obsolete, or duplicate WAZ files from SharePoint."""
    from app.models.project import Project
    from app.routes.pipeline_materials import _resequence_pipeline_waz_numbers_and_regenerate

    p = Pipeline.query.get_or_404(pipeline_id)
    project = Project.query.get_or_404(p.project_id)

    if not project.sharepoint_drive_id or not project.sharepoint_folder_id:
        return jsonify({"error": "No SharePoint folder configured for this project."}), 400

    regen_count, deleted_old = _resequence_pipeline_waz_numbers_and_regenerate(p.id, force_regenerate_all=True)

    return jsonify({
        "ok": True,
        "count": regen_count,
        "cleaned": deleted_old,
        "message": f"Successfully regenerated {regen_count} WAZ document(s) and removed {deleted_old} obsolete file(s) for pipeline {p.no}."
    }), 200
