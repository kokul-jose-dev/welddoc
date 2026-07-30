from flask import Blueprint, request, jsonify, current_app
from app.database import db
from app.models.project_material import ProjectMaterial
from app.models.global_material import GlobalMaterial
from app.models.project import Project
from app.models.client import Client
from app.sharepoint import upload_waz_document

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

    # Get hierarchy info
    project = Project.query.get(m.project_id)
    client = Client.query.get(project.client_id)
    project_name = project.title or project.ist_project_no or str(project.id)

    heat_no = m.heat_no or "unknown"
    certificate_no = m.certificate or "unknown"

    file_content = file.read()
    content_type = file.content_type or "application/pdf"

    url = upload_waz_document(
        client.id, client.name,
        project_name, project.ist_project_no,
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
    from app.sharepoint import _get_site_id, _get_drive_id, _get_app_token, _ssl_context, _sanitize_name, GRAPH_BASE
    import urllib.parse

    m = ProjectMaterial.query.get_or_404(pm_id)

    # Try to delete from SharePoint
    if m.waz_pdf_url:
        try:
            project = Project.query.get(m.project_id)
            client_obj = Client.query.get(project.client_id)
            site_id = _get_site_id()
            drive_id = _get_drive_id(site_id)
            base_path = current_app.config.get("SHAREPOINT_BASE_FOLDER", "weldoc")
            client_folder = _sanitize_name(f"{client_obj.name}_{client_obj.id}")
            project_name = project.title or project.ist_project_no or str(project.id)
            project_folder = _sanitize_name(f"{project_name}_{project.ist_project_no}")
            file_name = _sanitize_name(f"{m.heat_no or 'unknown'}_{m.certificate or 'unknown'}") + ".pdf"
            file_path = f"{base_path}/{client_folder}/{project_folder}/Materials/{file_name}"

            token = _get_app_token()
            encoded_path = urllib.parse.quote(file_path, safe="/")
            url = f"{GRAPH_BASE}/drives/{drive_id}/root:/{encoded_path}"
            import urllib.request
            req = urllib.request.Request(url, method="DELETE")
            req.add_header("Authorization", f"Bearer {token}")
            urllib.request.urlopen(req, context=_ssl_context())
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
