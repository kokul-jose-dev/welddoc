from flask import Blueprint, request, jsonify, current_app
from app.database import db
from app.models.project_material import ProjectMaterial
from app.models.global_material import GlobalMaterial
from app.models.project import Project
from app.models.client import Client
from app.material_utils import (
    clean_str,
    find_matching_project_material,
    merge_project_materials,
    check_heat_number_diff,
)

project_materials_bp = Blueprint("project_materials", __name__)


@project_materials_bp.route("/check-heat-diff", methods=["POST"])
def check_heat_diff():
    data = request.get_json() or {}
    heat_no = data.get("heatNo") or data.get("heat") or ""
    project_id = data.get("projectId")
    exclude_pm_id = data.get("excludeProjectMaterialId") or data.get("id")

    result = check_heat_number_diff(
        heat_no=heat_no,
        form_data=data,
        project_id=project_id,
        exclude_pm_id=exclude_pm_id,
    )
    return jsonify(result), 200



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
    data = request.get_json() or {}
    cert = clean_str(data.get("certificate"))
    heat = clean_str(data.get("heatNo"))
    waz_pdf_url = data.get("wazPdfUrl")

    if "id" in data and data["id"]:
        m = ProjectMaterial.query.get_or_404(data["id"])
        target_gm_id = data.get("globalMaterialId", m.global_material_id)

        # Check if updating this PM matches another existing PM in the same project
        existing_other = find_matching_project_material(
            m.project_id, target_gm_id, cert, heat, exclude_id=m.id
        )
        if existing_other:
            # Auto-merge: move all PipelineMaterials to existing_other
            merge_project_materials(m.id, existing_other.id)
            if waz_pdf_url and not existing_other.waz_pdf_url:
                existing_other.waz_pdf_url = waz_pdf_url
            db.session.commit()
            return jsonify(_serialize(existing_other)), 200

        # Update in place
        m.global_material_id = target_gm_id
        m.certificate = cert
        m.heat_no = heat
        if waz_pdf_url is not None:
            m.waz_pdf_url = waz_pdf_url
        if "archived" in data:
            m.archived = data["archived"]
        db.session.commit()
        return jsonify(_serialize(m)), 200
    else:
        raw_project_id = data.get("projectId")
        raw_gm_id = data.get("globalMaterialId")
        try:
            project_id = int(raw_project_id) if raw_project_id is not None else None
        except Exception:
            project_id = raw_project_id

        try:
            gm_id = int(raw_gm_id) if raw_gm_id is not None else None
        except Exception:
            gm_id = raw_gm_id

        # Check if same combination already exists in this project
        existing = find_matching_project_material(project_id, gm_id, cert, heat)
        if existing:
            if waz_pdf_url and not existing.waz_pdf_url:
                existing.waz_pdf_url = waz_pdf_url
                db.session.commit()
            return jsonify(_serialize(existing)), 200

        m = ProjectMaterial(
            project_id=project_id,
            global_material_id=gm_id,
            certificate=cert,
            heat_no=heat,
            waz_pdf_url=waz_pdf_url or "",
        )
        db.session.add(m)
        db.session.commit()

        if waz_pdf_url:
            import threading
            app = current_app._get_current_object()
            pm_id = m.id
            def _bg_copy():
                with app.app_context():
                    mat = ProjectMaterial.query.get(pm_id)
                    if mat:
                        _copy_waz_file_for_pm(mat)
            threading.Thread(target=_bg_copy, daemon=True).start()

        return jsonify(_serialize(m)), 201


def _copy_waz_file_for_pm(m):
    """If project material has a waz_pdf_url, ensure SharePoint has a copy formatted with this material's specs."""
    if not m.waz_pdf_url:
        return
    project = Project.query.get(m.project_id)
    if not project or not project.sharepoint_drive_id or not project.sharepoint_folder_id:
        return

    import base64
    import urllib.request
    from app.sharepoint import _get_app_token, _ssl_context, GRAPH_BASE, format_waz_filename, upload_waz_to_project_folder

    gm = m.global_material
    dns = [getattr(gm, f"dn{i}") for i in range(1, 7) if getattr(gm, f"dn{i}")] if gm else []
    dias = [d for d in [gm.diameter, gm.diameter2, gm.diameter3] if d] if gm else []
    thks = [t for t in [gm.thickness, gm.thickness2, gm.thickness3] if t] if gm else []
    target_name = format_waz_filename(
        item_desc=gm.item_description if gm else "",
        dn=gm.dn1 if gm else "",
        diameter=gm.diameter if gm else "",
        thickness=gm.thickness if gm else "",
        dns=dns,
        diameters=dias,
        thicknesses=thks,
        material_code=gm.material_code if gm else "",
        surface=gm.surface if gm else "",
        heat_no=m.heat_no or "",
    )

    try:
        token = _get_app_token()
        encoded_url = base64.urlsafe_b64encode(m.waz_pdf_url.encode()).decode().rstrip("=")
        share_id = "u!" + encoded_url
        download_url = f"{GRAPH_BASE}/shares/{share_id}/driveItem/content"
        req = urllib.request.Request(download_url)
        req.add_header("Authorization", f"Bearer {token}")
        with urllib.request.urlopen(req, context=_ssl_context()) as resp:
            file_content = resp.read()
        if file_content:
            new_url = upload_waz_to_project_folder(
                project.sharepoint_drive_id,
                project.sharepoint_folder_id,
                target_name,
                file_content,
                "application/pdf"
            )
            if new_url:
                m.waz_pdf_url = new_url
                db.session.commit()
    except Exception as e:
        current_app.logger.error(f"Failed to copy WAZ file for project material {m.id}: {e}")



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

    from app.sharepoint import upload_waz_to_project_folder, format_waz_filename

    gm = m.global_material
    dns = [getattr(gm, f"dn{i}") for i in range(1, 7) if getattr(gm, f"dn{i}")] if gm else []
    dias = [d for d in [gm.diameter, gm.diameter2, gm.diameter3] if d] if gm else []
    thks = [t for t in [gm.thickness, gm.thickness2, gm.thickness3] if t] if gm else []
    file_name = format_waz_filename(
        item_desc=gm.item_description if gm else "",
        dn=gm.dn1 if gm else "",
        diameter=gm.diameter if gm else "",
        thickness=gm.thickness if gm else "",
        dns=dns,
        diameters=dias,
        thicknesses=thks,
        material_code=gm.material_code if gm else "",
        surface=gm.surface if gm else "",
        heat_no=m.heat_no or "",
    )

    file_content = file.read()
    content_type = file.content_type or "application/pdf"

    url = upload_waz_to_project_folder(
        project.sharepoint_drive_id,
        project.sharepoint_folder_id,
        file_name,
        file_content,
        content_type,
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
