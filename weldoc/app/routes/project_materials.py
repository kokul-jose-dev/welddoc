from flask import Blueprint, request, jsonify, current_app
from app.database import db
from app.models.project_material import ProjectMaterial
from app.models.global_material import GlobalMaterial
from app.models.project import Project
from app.models.client import Client
from app.sharepoint import upload_waz_to_project_folder

project_materials_bp = Blueprint("project_materials", __name__)


@project_materials_bp.route("", methods=["GET"])
def get_project_materials():
    project_id = request.args.get("projectId", type=int)
    archived = request.args.get("archived", "false").lower() == "true"
    query = ProjectMaterial.query.filter_by(archived=archived)
    if project_id:
        query = query.filter_by(project_id=project_id)
    rows = query.all()
    return jsonify([_serialize(m) for m in rows])


@project_materials_bp.route("/<int:pm_id>", methods=["GET"])
def get_project_material(pm_id):
    m = ProjectMaterial.query.get_or_404(pm_id)
    return jsonify(_serialize(m))


@project_materials_bp.route("", methods=["POST"])
def create_or_update_project_material():
    data = request.get_json()
    if "id" in data and data["id"]:
        m = ProjectMaterial.query.get_or_404(data["id"])
        m.global_material_id = data.get("globalMaterialId", m.global_material_id)
        m.certificate = data.get("certificate", m.certificate)
        m.heat_no = data.get("heatNo", m.heat_no)
        if "wazPdfUrl" in data:
            m.waz_pdf_url = data["wazPdfUrl"]
        if "archived" in data:
            m.archived = data["archived"]
    else:
        # Check if same combination already exists in this project
        existing = ProjectMaterial.query.filter_by(
            project_id=data["projectId"],
            global_material_id=data["globalMaterialId"],
            certificate=data.get("certificate", ""),
            heat_no=data.get("heatNo", ""),
            archived=False,
        ).first()
        if existing:
            return jsonify(_serialize(existing)), 200

        m = ProjectMaterial(
            project_id=data["projectId"],
            global_material_id=data["globalMaterialId"],
            certificate=data.get("certificate", ""),
            heat_no=data.get("heatNo", ""),
        )
        db.session.add(m)
    db.session.commit()
    return jsonify(_serialize(m)), 200


@project_materials_bp.route("/<int:pm_id>/upload-waz", methods=["POST"])
def upload_waz(pm_id):
    """Upload a WAZ PDF document to SharePoint for a project material."""
    m = ProjectMaterial.query.get_or_404(pm_id)
    if "file" not in request.files:
        return jsonify({"error": "No file provided"}), 400

    file = request.files["file"]
    if not file.filename:
        return jsonify({"error": "Empty filename"}), 400

    # Get project's SharePoint folder
    project = Project.query.get(m.project_id)
    if not project.sharepoint_drive_id or not project.sharepoint_folder_id:
        return jsonify({"error": "No SharePoint folder configured for this project. Please set it in Project settings."}), 400

    heat_no = m.heat_no or "unknown"
    certificate_no = m.certificate or "unknown"

    file_content = file.read()
    content_type = file.content_type or "application/pdf"

    url = upload_waz_to_project_folder(
        project.sharepoint_drive_id,
        project.sharepoint_folder_id,
        heat_no, certificate_no,
        file_content, content_type
    )

    if url:
        m.waz_pdf_url = url
        db.session.commit()
        return jsonify({"wazPdfUrl": url}), 200
    else:
        return jsonify({"error": "Failed to upload to SharePoint"}), 500


@project_materials_bp.route("/<int:pm_id>/delete-waz", methods=["POST"])
def delete_waz(pm_id):
    """Delete WAZ document from SharePoint and clear the URL."""
    from app.sharepoint import _get_app_token, _ssl_context, _sanitize_name, GRAPH_BASE
    import urllib.parse
    import json

    m = ProjectMaterial.query.get_or_404(pm_id)

    # Try to delete from SharePoint using the project's saved folder
    if m.waz_pdf_url:
        try:
            project = Project.query.get(m.project_id)
            if project.sharepoint_drive_id:
                token = _get_app_token()
                import urllib.request
                import ssl, certifi
                ctx = ssl.create_default_context(cafile=certifi.where())
                file_name = _sanitize_name(f"{m.heat_no or 'unknown'}_{m.certificate or 'unknown'}") + ".pdf"
                # Get file by path: /WAZ/filename.pdf relative to the project folder
                file_path = urllib.parse.quote(f"WAZ/{file_name}", safe="/")
                item_url = f"{GRAPH_BASE}/drives/{project.sharepoint_drive_id}/items/{project.sharepoint_folder_id}:/{file_path}"
                req = urllib.request.Request(item_url)
                req.add_header("Authorization", f"Bearer {token}")
                with urllib.request.urlopen(req, context=ctx) as resp:
                    file_item = json.loads(resp.read())
                    file_id = file_item["id"]
                # Delete by item ID
                del_url = f"{GRAPH_BASE}/drives/{project.sharepoint_drive_id}/items/{file_id}"
                req2 = urllib.request.Request(del_url, method="DELETE")
                req2.add_header("Authorization", f"Bearer {token}")
                urllib.request.urlopen(req2, context=ctx)
                current_app.logger.info(f"SharePoint: Deleted WAZ document '{file_name}'")
        except Exception as e:
            current_app.logger.error(f"SharePoint delete failed: {e}")

    m.waz_pdf_url = None
    db.session.commit()
    return jsonify({"ok": True}), 200


def _serialize(m):
    gm = m.global_material
    return {
        "id": m.id,
        "projectId": m.project_id,
        "globalMaterialId": m.global_material_id,
        "certificate": m.certificate,
        "heatNo": m.heat_no,
        "wazPdfUrl": m.waz_pdf_url,
        "archived": m.archived,
        # Include global material fields for convenience
        "category": gm.category if gm else None,
        "dn1": gm.dn1 if gm else None,
        "dn2": gm.dn2 if gm else None,
        "dn3": gm.dn3 if gm else None,
        "dn4": gm.dn4 if gm else None,
        "dn5": gm.dn5 if gm else None,
        "dn6": gm.dn6 if gm else None,
        "diameter": gm.diameter if gm else None,
        "thickness": gm.thickness if gm else None,
        "surface": gm.surface if gm else None,
        "itemDescription": gm.item_description if gm else None,
        "materialCode": gm.material_code if gm else None,
        "dienNo": gm.dien_no if gm else None,
    }
