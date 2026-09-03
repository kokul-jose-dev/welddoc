from flask import Blueprint, jsonify, request
from app.database import db

page_views_bp = Blueprint("page_views", __name__)


def _ser_client(r):
    return {
        "id": r.id,
        "name": r.name,
        "street": r.street,
        "zipCode": r.zip_code,
        "location": r.location,
        "remarks": r.remarks,
        "archived": r.archived,
    }


def _ser_project(r):
    return {
        "id": r.id,
        "clientId": r.client_id,
        "istProjectNo": r.ist_project_no,
        "title": r.title,
        "location": r.location,
        "order": r.order_no or "",
        "orderNo": r.order_no or "",
        "description": r.description,
        "status": r.status,
        "archived": r.archived,
        "sharepointDriveId": r.sharepoint_drive_id,
        "sharepointFolderId": r.sharepoint_folder_id,
        "sharepointFolderUrl": r.sharepoint_folder_url,
    }


def _ser_pipeline(r):
    return {
        "id": r.id,
        "projectId": r.project_id,
        "no": r.no,
        "plant": r.plant,
        "status": r.status,
        "docIso": r.doc_iso,
        "docBuilder": r.doc_builder,
        "docFinal": r.doc_final,
        "weldingStart": r.welding_start,
        "weldingEnd": r.welding_end,
        "weldingRemarks": r.welding_remarks,
        "archived": r.archived,
    }


@page_views_bp.route("/clients", methods=["GET"])
def get_clients_page():
    """Single SQL round-trip for Clients list page."""
    c_rows = db.session.execute(db.text("""
        SELECT id, name, street, zip_code, location, remarks, archived
        FROM weldoc_clients WHERE archived = 0 ORDER BY name
    """)).fetchall()

    p_rows = db.session.execute(db.text("""
        SELECT p.id, p.client_id, p.ist_project_no, p.title, p.location, p.order_no,
               p.description, p.status, p.archived, p.sharepoint_drive_id,
               p.sharepoint_folder_id, p.sharepoint_folder_url
        FROM weldoc_projects p
        JOIN weldoc_clients c ON p.client_id = c.id
        WHERE p.archived = 0 AND c.archived = 0
        ORDER BY p.id DESC
    """)).fetchall()

    pl_rows = db.session.execute(db.text("""
        SELECT pl.id, pl.project_id, pl.no, pl.plant, pl.status, pl.doc_iso, pl.doc_builder,
               pl.doc_final, pl.welding_start, pl.welding_end, pl.welding_remarks, pl.archived
        FROM weldoc_pipelines pl
        JOIN weldoc_projects p ON pl.project_id = p.id
        JOIN weldoc_clients c ON p.client_id = c.id
        WHERE pl.archived = 0 AND p.archived = 0 AND c.archived = 0
        ORDER BY pl.id DESC
    """)).fetchall()

    return jsonify({
        "clients": [_ser_client(r) for r in c_rows],
        "projects": [_ser_project(r) for r in p_rows],
        "pipelines": [_ser_pipeline(r) for r in pl_rows],
    })


@page_views_bp.route("/projects", methods=["GET"])
def get_projects_page():
    """Single SQL round-trip for Projects list page."""
    c_rows = db.session.execute(db.text("""
        SELECT id, name, street, zip_code, location, remarks, archived
        FROM weldoc_clients WHERE archived = 0 ORDER BY name
    """)).fetchall()

    p_rows = db.session.execute(db.text("""
        SELECT p.id, p.client_id, p.ist_project_no, p.title, p.location, p.order_no,
               p.description, p.status, p.archived, p.sharepoint_drive_id,
               p.sharepoint_folder_id, p.sharepoint_folder_url
        FROM weldoc_projects p
        JOIN weldoc_clients c ON p.client_id = c.id
        WHERE p.archived = 0 AND c.archived = 0
        ORDER BY p.id DESC
    """)).fetchall()

    pl_rows = db.session.execute(db.text("""
        SELECT pl.id, pl.project_id, pl.no, pl.plant, pl.status, pl.doc_iso, pl.doc_builder,
               pl.doc_final, pl.welding_start, pl.welding_end, pl.welding_remarks, pl.archived
        FROM weldoc_pipelines pl
        JOIN weldoc_projects p ON pl.project_id = p.id
        JOIN weldoc_clients c ON p.client_id = c.id
        WHERE pl.archived = 0 AND p.archived = 0 AND c.archived = 0
        ORDER BY pl.id DESC
    """)).fetchall()

    return jsonify({
        "clients": [_ser_client(r) for r in c_rows],
        "projects": [_ser_project(r) for r in p_rows],
        "pipelines": [_ser_pipeline(r) for r in pl_rows],
    })


@page_views_bp.route("/pipelines", methods=["GET"])
def get_pipelines_page():
    """Single SQL round-trip for Pipelines list page."""
    c_rows = db.session.execute(db.text("""
        SELECT id, name, street, zip_code, location, remarks, archived
        FROM weldoc_clients WHERE archived = 0 ORDER BY name
    """)).fetchall()

    pr_rows = db.session.execute(db.text("""
        SELECT p.id, p.client_id, p.ist_project_no, p.title, p.location, p.order_no,
               p.description, p.status, p.archived, p.sharepoint_drive_id,
               p.sharepoint_folder_id, p.sharepoint_folder_url
        FROM weldoc_projects p
        JOIN weldoc_clients c ON p.client_id = c.id
        WHERE p.archived = 0 AND c.archived = 0
        ORDER BY p.id DESC
    """)).fetchall()

    pl_rows = db.session.execute(db.text("""
        SELECT pl.id, pl.project_id, pl.no, pl.plant, pl.status, pl.doc_iso, pl.doc_builder,
               pl.doc_final, pl.welding_start, pl.welding_end, pl.welding_remarks, pl.archived
        FROM weldoc_pipelines pl
        JOIN weldoc_projects p ON pl.project_id = p.id
        JOIN weldoc_clients c ON p.client_id = c.id
        WHERE pl.archived = 0 AND p.archived = 0 AND c.archived = 0
        ORDER BY pl.id DESC
    """)).fetchall()

    return jsonify({
        "clients": [_ser_client(r) for r in c_rows],
        "projects": [_ser_project(r) for r in pr_rows],
        "pipelines": [_ser_pipeline(r) for r in pl_rows],
    })


@page_views_bp.route("/client-detail/<int:client_id>", methods=["GET"])
def get_client_detail_page(client_id):
    """Single SQL round-trip for Client Detail page."""
    cli = db.session.execute(db.text("""
        SELECT id, name, street, zip_code, location, remarks, archived
        FROM weldoc_clients WHERE id = :cid
    """), {"cid": client_id}).fetchone()

    if not cli:
        return jsonify({"error": "Client not found"}), 404

    # All clients for the switcher dropdown
    all_clients = db.session.execute(db.text("""
        SELECT id, name, street, zip_code, location, remarks, archived
        FROM weldoc_clients WHERE archived = 0 ORDER BY name
    """)).fetchall()

    # Only projects for THIS client
    p_rows = db.session.execute(db.text("""
        SELECT id, client_id, ist_project_no, title, location, order_no,
               description, status, archived, sharepoint_drive_id,
               sharepoint_folder_id, sharepoint_folder_url
        FROM weldoc_projects WHERE client_id = :cid AND archived = 0 ORDER BY id DESC
    """), {"cid": client_id}).fetchall()

    # Pipelines for this client's projects
    proj_ids = [r.id for r in p_rows]
    pl_rows = []
    if proj_ids:
        placeholders = ",".join(str(int(pid)) for pid in proj_ids)
        pl_rows = db.session.execute(db.text(f"""
            SELECT id, project_id, no, plant, status, doc_iso, doc_builder,
                   doc_final, welding_start, welding_end, welding_remarks, archived
            FROM weldoc_pipelines
            WHERE project_id IN ({placeholders}) AND archived = 0
            ORDER BY id DESC
        """)).fetchall()

    return jsonify({
        "client": _ser_client(cli),
        "clients": [_ser_client(r) for r in all_clients],
        "projects": [_ser_project(r) for r in p_rows],
        "pipelines": [_ser_pipeline(r) for r in pl_rows],
    })


@page_views_bp.route("/project-detail/<int:project_id>", methods=["GET"])
def get_project_detail_page(project_id):
    """Single SQL round-trip for Project Detail page."""
    pr_row = db.session.execute(db.text("""
        SELECT p.id as pr_id, p.client_id, p.ist_project_no, p.title as pr_title,
               p.location as pr_location, p.order_no, p.description as pr_desc,
               p.status as pr_status, p.archived as pr_archived,
               p.sharepoint_drive_id, p.sharepoint_folder_id, p.sharepoint_folder_url,
               c.id as c_id, c.name as c_name, c.street, c.zip_code,
               c.location as c_location, c.remarks, c.archived as c_archived
        FROM weldoc_projects p
        LEFT JOIN weldoc_clients c ON p.client_id = c.id
        WHERE p.id = :pid
    """), {"pid": project_id}).fetchone()

    if not pr_row:
        return jsonify({"error": "Project not found"}), 404

    # Sibling projects for project switcher
    sib_projects = db.session.execute(db.text("""
        SELECT id, client_id, ist_project_no, title, location, order_no,
               description, status, archived, sharepoint_drive_id,
               sharepoint_folder_id, sharepoint_folder_url
        FROM weldoc_projects WHERE client_id = :cid AND archived = 0
    """), {"cid": pr_row.client_id}).fetchall()

    # Pipelines in this project
    pl_rows = db.session.execute(db.text("""
        SELECT id, project_id, no, plant, status, doc_iso, doc_builder,
               doc_final, welding_start, welding_end, welding_remarks, archived
        FROM weldoc_pipelines WHERE project_id = :pid AND archived = 0 ORDER BY id DESC
    """), {"pid": project_id}).fetchall()

    # Project materials JOINed with global materials
    pm_rows = db.session.execute(db.text("""
        SELECT pm.id, pm.project_id, pm.global_material_id, pm.certificate,
               pm.heat_no, pm.waz_pdf_url, pm.archived,
               gm.category, gm.item_description, gm.dn1, gm.dn2, gm.dn3,
               gm.dn4, gm.dn5, gm.dn6, gm.diameter, gm.thickness,
               gm.surface, gm.material_code, gm.dien_no
        FROM weldoc_project_materials pm
        LEFT JOIN weldoc_global_materials gm ON pm.global_material_id = gm.id
        WHERE pm.project_id = :pid AND pm.archived = 0
    """), {"pid": project_id}).fetchall()

    # Global materials for dropdowns
    gm_rows = db.session.execute(db.text("""
        SELECT id, category, dn1, dn2, dn3, dn4, dn5, dn6, diameter,
               thickness, surface, item_description, material_code, dien_no, archived
        FROM weldoc_global_materials WHERE archived = 0 ORDER BY category, item_description
    """)).fetchall()

    return jsonify({
        "client": {
            "id": pr_row.c_id, "name": pr_row.c_name, "street": pr_row.street,
            "zipCode": pr_row.zip_code, "location": pr_row.c_location,
            "remarks": pr_row.remarks, "archived": pr_row.c_archived,
        } if pr_row.c_id else None,
        "project": {
            "id": pr_row.pr_id, "clientId": pr_row.client_id,
            "istProjectNo": pr_row.ist_project_no, "title": pr_row.pr_title,
            "location": pr_row.pr_location, "order": pr_row.order_no or "",
            "orderNo": pr_row.order_no or "", "description": pr_row.pr_desc,
            "status": pr_row.pr_status, "archived": pr_row.pr_archived,
            "sharepointDriveId": pr_row.sharepoint_drive_id,
            "sharepointFolderId": pr_row.sharepoint_folder_id,
            "sharepointFolderUrl": pr_row.sharepoint_folder_url,
        },
        "projects": [_ser_project(r) for r in sib_projects],
        "pipelines": [_ser_pipeline(r) for r in pl_rows],
        "projectMaterials": [{
            "id": r.id, "projectId": r.project_id,
            "globalMaterialId": r.global_material_id,
            "certificate": r.certificate, "heatNo": r.heat_no,
            "wazPdfUrl": r.waz_pdf_url, "archived": r.archived,
            "category": r.category, "itemDescription": r.item_description,
            "dn1": r.dn1, "dn2": r.dn2, "dn3": r.dn3,
            "dn4": r.dn4, "dn5": r.dn5, "dn6": r.dn6,
            "diameter": r.diameter, "thickness": r.thickness,
            "surface": r.surface, "materialCode": r.material_code,
            "dienNo": r.dien_no,
        } for r in pm_rows],
        "globalMaterials": [{
            "id": r.id, "category": r.category, "piece": r.category,
            "dn1": r.dn1, "dimension": r.dn1, "dn2": r.dn2, "dimension2": r.dn2,
            "dn3": r.dn3, "dimension3": r.dn3, "dn4": r.dn4, "dimension4": r.dn4,
            "dn5": r.dn5, "dimension5": r.dn5, "dn6": r.dn6, "dimension6": r.dn6,
            "diameter": r.diameter, "thickness": r.thickness,
            "surface": r.surface, "itemDescription": r.item_description,
            "materialCode": r.material_code, "dienNo": r.dien_no,
            "archived": r.archived,
        } for r in gm_rows],
    })


@page_views_bp.route("/home", methods=["GET"])
def get_home_page():
    """Single SQL round-trip for Home Dashboard."""
    c_rows = db.session.execute(db.text("""
        SELECT id, name, street, zip_code, location, remarks, archived
        FROM weldoc_clients WHERE archived = 0
    """)).fetchall()

    pr_rows = db.session.execute(db.text("""
        SELECT id, client_id, ist_project_no, title, location, order_no,
               description, status, archived, sharepoint_drive_id,
               sharepoint_folder_id, sharepoint_folder_url
        FROM weldoc_projects WHERE archived = 0
    """)).fetchall()

    pl_rows = db.session.execute(db.text("""
        SELECT id, project_id, no, plant, status, doc_iso, doc_builder,
               doc_final, welding_start, welding_end, welding_remarks, archived
        FROM weldoc_pipelines WHERE archived = 0
    """)).fetchall()

    # Materials for WAZ checking on Home dashboard
    mat_rows = db.session.execute(db.text("""
        SELECT pm.id, pm.pipeline_id, pm.project_material_id, pm.position,
               pm.waz_no, pm.start_of_plumbing, pm.end_of_plumbing, pm.archived,
               prm.certificate, prm.heat_no, prm.waz_pdf_url
        FROM weldoc_pipeline_materials pm
        LEFT JOIN weldoc_project_materials prm ON pm.project_material_id = prm.id
        WHERE pm.archived = 0
    """)).fetchall()

    weld_rows = db.session.execute(db.text("""
        SELECT id, pipeline_id, weld_no, between_a, between_b, type, [procedure],
               welding_wire, welder, inspector, welder_id, inspector_id, date,
               endoscopy_video_url, endoscopy_image_url, remarks, archived
        FROM weldoc_welds WHERE archived = 0
    """)).fetchall()

    w_rows = db.session.execute(db.text("""
        SELECT id, name, no, signature_url, archived
        FROM weldoc_welders WHERE archived = 0
    """)).fetchall()

    cert_rows = db.session.execute(db.text("""
        SELECT id, welder_id, cert_no, process, standard, valid_until, renewal_due, pdf_url, archived
        FROM weldoc_weldercertificate WHERE archived = 0
    """)).fetchall()

    return jsonify({
        "clients": [_ser_client(r) for r in c_rows],
        "projects": [_ser_project(r) for r in pr_rows],
        "pipelines": [_ser_pipeline(r) for r in pl_rows],
        "materials": [{
            "id": r.id, "pipelineId": r.pipeline_id,
            "projectMaterialId": r.project_material_id,
            "position": r.position, "wazNo": r.waz_no,
            "startOfPlumbing": r.start_of_plumbing,
            "endOfPlumbing": r.end_of_plumbing, "archived": r.archived,
            "certificate": r.certificate, "heatNo": r.heat_no,
            "wazPdfUrl": r.waz_pdf_url,
        } for r in mat_rows],
        "welds": [{
            "id": w.id, "pipelineId": w.pipeline_id,
            "weldNo": w.weld_no, "betweenA": w.between_a, "betweenB": w.between_b,
            "type": w.type, "procedure": getattr(w, 'procedure', ''),
            "weldingWire": w.welding_wire, "welder": w.welder, "inspector": w.inspector,
            "welderId": w.welder_id, "inspectorId": w.inspector_id,
            "date": w.date, "endoscopyVideoUrl": w.endoscopy_video_url,
            "endoscopyImageUrl": w.endoscopy_image_url, "remarks": w.remarks,
            "archived": w.archived,
        } for w in weld_rows],
        "people": [{
            "id": r.id, "name": r.name, "no": r.no or "",
            "signatureUrl": r.signature_url or "",
            "archived": r.archived,
        } for r in w_rows],
        "certificates": [{
            "id": r.id, "personId": r.welder_id, "welderId": r.welder_id,
            "certNo": r.cert_no, "process": r.process or "",
            "standard": r.standard or "", "validUntil": r.valid_until or "",
            "renewalDue": r.renewal_due or "", "pdfUrl": r.pdf_url or "",
            "archived": r.archived,
        } for r in cert_rows],
    })


@page_views_bp.route("/materials", methods=["GET"])
def get_materials_page():
    """Single SQL round-trip for Global Materials master page."""
    c_rows = db.session.execute(db.text("""
        SELECT id, name, street, zip_code, location, remarks, archived
        FROM weldoc_clients WHERE archived = 0 ORDER BY name
    """)).fetchall()

    pr_rows = db.session.execute(db.text("""
        SELECT p.id, p.client_id, p.ist_project_no, p.title, p.location, p.order_no,
               p.description, p.status, p.archived, p.sharepoint_drive_id,
               p.sharepoint_folder_id, p.sharepoint_folder_url
        FROM weldoc_projects p
        JOIN weldoc_clients c ON p.client_id = c.id
        WHERE p.archived = 0 AND c.archived = 0
        ORDER BY p.id DESC
    """)).fetchall()

    pl_rows = db.session.execute(db.text("""
        SELECT pl.id, pl.project_id, pl.no, pl.plant, pl.status, pl.doc_iso, pl.doc_builder,
               pl.doc_final, pl.welding_start, pl.welding_end, pl.welding_remarks, pl.archived
        FROM weldoc_pipelines pl
        JOIN weldoc_projects p ON pl.project_id = p.id
        JOIN weldoc_clients c ON p.client_id = c.id
        WHERE pl.archived = 0 AND p.archived = 0 AND c.archived = 0
        ORDER BY pl.id DESC
    """)).fetchall()

    gm_rows = db.session.execute(db.text("""
        SELECT id, category, dn1, dn2, dn3, dn4, dn5, dn6, diameter,
               thickness, surface, item_description, material_code, dien_no, archived
        FROM weldoc_global_materials WHERE archived = 0 ORDER BY category, item_description
    """)).fetchall()

    return jsonify({
        "clients": [_ser_client(r) for r in c_rows],
        "projects": [_ser_project(r) for r in pr_rows],
        "pipelines": [_ser_pipeline(r) for r in pl_rows],
        "materials": [{
            "id": r.id, "category": r.category, "piece": r.category,
            "dn1": r.dn1, "dimension": r.dn1, "dn2": r.dn2, "dimension2": r.dn2,
            "dn3": r.dn3, "dimension3": r.dn3, "dn4": r.dn4, "dimension4": r.dn4,
            "dn5": r.dn5, "dimension5": r.dn5, "dn6": r.dn6, "dimension6": r.dn6,
            "diameter": r.diameter, "thickness": r.thickness,
            "surface": r.surface, "itemDescription": r.item_description,
            "materialCode": r.material_code, "dienNo": r.dien_no,
            "archived": r.archived,
        } for r in gm_rows],
    })


@page_views_bp.route("/archive", methods=["GET"])
def get_archive_page():
    """Single fast SQL round-trip for the Archive page."""
    c_rows = db.session.execute(db.text("""
        SELECT id, name, street, zip_code, location, remarks, archived
        FROM weldoc_clients ORDER BY name
    """)).fetchall()

    pr_rows = db.session.execute(db.text("""
        SELECT id, client_id, ist_project_no, title, location, order_no,
               description, status, archived, sharepoint_drive_id,
               sharepoint_folder_id, sharepoint_folder_url
        FROM weldoc_projects ORDER BY id DESC
    """)).fetchall()

    pl_rows = db.session.execute(db.text("""
        SELECT id, project_id, no, plant, status, doc_iso, doc_builder,
               doc_final, welding_start, welding_end, welding_remarks, archived
        FROM weldoc_pipelines ORDER BY id DESC
    """)).fetchall()

    mat_rows = db.session.execute(db.text("""
        SELECT pm.id, pm.pipeline_id, pm.position, pm.waz_no, pm.start_of_plumbing,
               pm.end_of_plumbing, pm.archived, gm.category, gm.item_description,
               gm.dn1, gm.dn2, gm.dn3, gm.dn4, gm.dn5, gm.dn6, gm.diameter,
               gm.thickness, gm.surface, gm.material_code, gm.dien_no,
               proj.certificate, proj.heat_no, proj.waz_pdf_url
        FROM weldoc_pipeline_materials pm
        LEFT JOIN weldoc_project_materials proj ON pm.project_material_id = proj.id
        LEFT JOIN weldoc_global_materials gm ON proj.global_material_id = gm.id
        WHERE pm.archived = 1
        ORDER BY pm.position
    """)).fetchall()

    weld_rows = db.session.execute(db.text("""
        SELECT id, pipeline_id, weld_no, between_a, between_b, type, [procedure],
               welding_wire, welder, inspector, welder_id, inspector_id, date,
               endoscopy_video_url, endoscopy_image_url, remarks, archived
        FROM weldoc_welds
        WHERE archived = 1
        ORDER BY id DESC
    """)).fetchall()

    return jsonify({
        "clients": [_ser_client(r) for r in c_rows],
        "projects": [_ser_project(r) for r in pr_rows],
        "pipelines": [_ser_pipeline(r) for r in pl_rows],
        "materials": [{
            "id": r.id, "pipelineId": r.pipeline_id, "position": r.position,
            "piece": r.category or "", "dimension": r.dn1 or "",
            "dimension2": r.dn2 or "", "dimension3": r.dn3 or "",
            "dimension4": r.dn4 or "", "dimension5": r.dn5 or "",
            "dimension6": r.dn6 or "", "dienNo": r.dien_no or "",
            "materialCode": r.material_code or "", "diameter": r.diameter or "",
            "thickness": r.thickness or "", "surface": r.surface or "",
            "itemDescription": r.item_description or "", "certificate": r.certificate or "",
            "heatNo": r.heat_no or "", "wazNo": r.waz_no or "",
            "wazPdfUrl": r.waz_pdf_url or "", "startOfPlumbing": bool(r.start_of_plumbing),
            "endOfPlumbing": bool(r.end_of_plumbing), "archived": bool(r.archived),
        } for r in mat_rows],
        "welds": [{
            "id": w.id, "pipelineId": w.pipeline_id,
            "weldNo": w.weld_no, "betweenA": w.between_a, "betweenB": w.between_b,
            "type": w.type, "procedure": getattr(w, 'procedure', ''),
            "weldingWire": w.welding_wire, "welder": w.welder, "inspector": w.inspector,
            "welderId": w.welder_id, "inspectorId": w.inspector_id,
            "date": w.date, "endoscopyVideoUrl": w.endoscopy_video_url,
            "endoscopyImageUrl": w.endoscopy_image_url, "remarks": w.remarks,
            "archived": bool(w.archived),
        } for w in weld_rows],
    })
