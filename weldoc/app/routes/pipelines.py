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


@pipelines_bp.route("/<int:pipeline_id>/regenerate-waz", methods=["POST"])
def regenerate_pipeline_waz(pipeline_id):
    """Regenerate all WAZ cover sheets and merged packages with current details for this pipeline,
    and remove any old, obsolete, or duplicate WAZ files from SharePoint."""
    from app.models.pipeline_material import PipelineMaterial
    from app.models.project import Project
    from app.routes.pipeline_materials import _sync_pipeline_waz_nos, _build_and_save_waz_package_with_bytes
    from app.sharepoint import format_waz_filename, clean_pipeline_waz_folder

    p = Pipeline.query.get_or_404(pipeline_id)
    project = Project.query.get_or_404(p.project_id)

    if not project.sharepoint_drive_id or not project.sharepoint_folder_id:
        return jsonify({"error": "No SharePoint folder configured for this project."}), 400

    _sync_pipeline_waz_nos(p.id)

    active_mats = PipelineMaterial.query.filter_by(pipeline_id=p.id, archived=False).all()
    waz_groups = {}
    for m in active_mats:
        pm = m.project_material
        if pm and pm.waz_pdf_url and m.waz_no:
            waz_key = m.waz_no.strip().upper()
            if waz_key not in waz_groups:
                waz_groups[waz_key] = []
            waz_groups[waz_key].append(m)

    valid_filenames = set()
    total_waz_regenerated = 0

    for waz_key, mats_for_waz in waz_groups.items():
        primary_m = mats_for_waz[0]
        pm = primary_m.project_material
        gm = pm.global_material if pm else None

        pkg_name = format_waz_filename(
            item_desc=gm.item_description if gm else "",
            dn=gm.dn1 if gm else "",
            diameter=gm.diameter if gm else "",
            thickness=gm.thickness if gm else "",
            material_code=gm.material_code if gm else "",
            surface=gm.surface if gm else "",
            heat_no=pm.heat_no or "",
            waz_no=primary_m.waz_no or "WAZ",
        )
        valid_filenames.add(pkg_name)

        pkg_url, merged_bytes = _build_and_save_waz_package_with_bytes(primary_m, file_content=None)
        if pkg_url:
            total_waz_regenerated += 1
            for m in mats_for_waz:
                m.waz_package_url = pkg_url
            db.session.commit()

    # Clean up all obsolete/duplicate files in the pipeline WAZ folder on SharePoint
    deleted_old = clean_pipeline_waz_folder(
        project.sharepoint_drive_id,
        project.sharepoint_folder_id,
        p.no,
        keep_filenames=valid_filenames
    )

    return jsonify({
        "ok": True,
        "count": total_waz_regenerated,
        "cleaned": deleted_old,
        "message": f"Successfully regenerated {total_waz_regenerated} WAZ document(s) and removed {deleted_old} obsolete file(s) for pipeline {p.no}."
    }), 200
