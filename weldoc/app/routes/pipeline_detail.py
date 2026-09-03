from flask import Blueprint, jsonify
from app.database import db

pipeline_detail_bp = Blueprint("pipeline_detail", __name__)


@pipeline_detail_bp.route("/<int:pipeline_id>", methods=["GET"])
def get_pipeline_detail(pipeline_id):
    """Single SQL round-trip for all pipeline-detail page data."""
    # One query: pipeline + project + client + sibling pipelines + materials (all JOINed)
    row = db.session.execute(db.text("""
        SELECT p.id as p_id, p.project_id, p.no, p.plant, p.status, p.doc_iso,
               p.doc_builder, p.doc_final, p.welding_start, p.welding_end,
               p.welding_remarks, p.archived as p_archived,
               pr.id as pr_id, pr.client_id, pr.ist_project_no, pr.title as pr_title,
               pr.location as pr_location, pr.order_no, pr.description as pr_desc,
               pr.status as pr_status, pr.archived as pr_archived,
               pr.sharepoint_drive_id, pr.sharepoint_folder_id, pr.sharepoint_folder_url,
               c.id as c_id, c.name as c_name, c.street, c.zip_code,
               c.location as c_location, c.remarks, c.archived as c_archived
        FROM weldoc_pipelines p
        LEFT JOIN weldoc_projects pr ON p.project_id = pr.id
        LEFT JOIN weldoc_clients c ON pr.client_id = c.id
        WHERE p.id = :pid
    """), {"pid": pipeline_id}).fetchone()

    if not row:
        return jsonify({"error": "not found"}), 404

    # Materials in one JOIN query
    mat_rows = db.session.execute(db.text("""
        SELECT pm.id, pm.pipeline_id, pm.project_material_id, pm.position,
               pm.waz_no, pm.waz_package_url, pm.start_of_plumbing, pm.end_of_plumbing, pm.archived,
               prm.certificate, prm.heat_no, prm.waz_pdf_url,
               gm.category, gm.item_description, gm.dn1, gm.dn2, gm.dn3,
               gm.dn4, gm.dn5, gm.dn6, gm.diameter, gm.thickness,
               gm.surface, gm.material_code, gm.dien_no
        FROM weldoc_pipeline_materials pm
        LEFT JOIN weldoc_project_materials prm ON pm.project_material_id = prm.id
        LEFT JOIN weldoc_global_materials gm ON prm.global_material_id = gm.id
        WHERE pm.pipeline_id = :pid AND pm.archived = 0
        ORDER BY pm.position
    """), {"pid": pipeline_id}).fetchall()

    # Connections + sibling pipelines in one query each
    mat_ids = [r.id for r in mat_rows]
    valid_conn_ids = {r.id for r in mat_rows if (r.category or '').strip().lower() != 'welding wire'}
    connections = {}
    if mat_ids:
        placeholders = ",".join(str(int(mid)) for mid in mat_ids)
        conn_rows = db.session.execute(db.text(f"""
            SELECT pipeline_material_id, connected_id
            FROM weldoc_pipeline_material_connections
            WHERE pipeline_material_id IN ({placeholders})
        """)).fetchall()
        for cr in conn_rows:
            if cr.connected_id in valid_conn_ids:
                connections.setdefault(cr.pipeline_material_id, []).append(cr.connected_id)

    sib_rows = db.session.execute(db.text("""
        SELECT id, project_id, no, plant, status, doc_iso, doc_builder, doc_final,
               welding_start, welding_end, welding_remarks, archived
        FROM weldoc_pipelines
        WHERE project_id = :proj_id AND archived = 0
    """), {"proj_id": row.project_id}).fetchall()

    weld_rows = db.session.execute(db.text("""
        SELECT id, pipeline_id, weld_no, between_a, between_b, type, [procedure],
               welding_wire, welder, inspector, welder_id, inspector_id, date,
               endoscopy_video_url, endoscopy_image_url, remarks, archived
        FROM weldoc_welds
        WHERE pipeline_id = :pid AND archived = 0
    """), {"pid": pipeline_id}).fetchall()

    pm_rows = db.session.execute(db.text("""
        SELECT pm.id, pm.project_id, pm.global_material_id, pm.certificate, pm.heat_no,
               pm.waz_pdf_url, pm.archived,
               gm.category, gm.item_description, gm.dn1, gm.dn2, gm.dn3,
               gm.dn4, gm.dn5, gm.dn6, gm.diameter, gm.thickness,
               gm.surface, gm.material_code, gm.dien_no
        FROM weldoc_project_materials pm
        LEFT JOIN weldoc_global_materials gm ON pm.global_material_id = gm.id
        WHERE pm.project_id = :proj_id AND pm.archived = 0
    """), {"proj_id": row.project_id}).fetchall()

    gm_rows = db.session.execute(db.text("""
        SELECT id, category, item_description, dn1, dn2, dn3, dn4, dn5, dn6,
               diameter, thickness, surface, material_code, dien_no, archived
        FROM weldoc_global_materials
        WHERE archived = 0
        ORDER BY category, item_description
    """)).fetchall()

    w_rows = db.session.execute(db.text("""
        SELECT w.id, w.name, w.no, w.signature_url, w.archived,
               c.id as c_id, c.welder_id, c.cert_no, c.process, c.standard,
               c.valid_until, c.renewal_due, c.pdf_url, c.archived as c_archived
        FROM weldoc_welders w
        LEFT JOIN weldoc_weldercertificate c ON w.id = c.welder_id AND c.archived = 0
        WHERE w.archived = 0
        ORDER BY w.name
    """)).fetchall()

    welder_map = {}
    for wr in w_rows:
        if wr.id not in welder_map:
            welder_map[wr.id] = {
                "id": wr.id,
                "name": wr.name,
                "no": wr.no or "",
                "signatureUrl": getattr(wr, 'signature_url', '') or "",
                "archived": wr.archived,
                "certificates": [],
                "procs_set": set(),
            }
        if wr.c_id:
            welder_map[wr.id]["certificates"].append({
                "id": wr.c_id,
                "welderId": wr.welder_id,
                "certNo": wr.cert_no,
                "process": wr.process or "",
                "standard": wr.standard or "",
                "validUntil": wr.valid_until or "",
                "renewalDue": wr.renewal_due or "",
                "pdfUrl": wr.pdf_url or "",
                "archived": wr.c_archived,
            })
            if wr.process:
                welder_map[wr.id]["procs_set"].add(wr.process)

    welders = []
    for w in welder_map.values():
        w["procs"] = " / ".join(sorted(w.pop("procs_set")))
        welders.append(w)

    materials = []
    for r in mat_rows:
        materials.append({
            "id": r.id, "pipelineId": r.pipeline_id,
            "projectMaterialId": r.project_material_id,
            "position": r.position, "wazNo": r.waz_no,
            "startOfPlumbing": r.start_of_plumbing,
            "endOfPlumbing": r.end_of_plumbing, "archived": r.archived,
            "connections": connections.get(r.id, []),
            "certificate": r.certificate, "heatNo": r.heat_no,
            "wazPdfUrl": r.waz_pdf_url,
            "wazPackageUrl": getattr(r, 'waz_package_url', '') or "",
            "category": r.category, "itemDescription": r.item_description,
            "dn1": r.dn1, "dn2": r.dn2, "dn3": r.dn3,
            "dn4": r.dn4, "dn5": r.dn5, "dn6": r.dn6,
            "diameter": r.diameter, "thickness": r.thickness,
            "surface": r.surface, "materialCode": r.material_code,
            "dienNo": r.dien_no,
        })

    welds = []
    for w in weld_rows:
        welds.append({
            "id": w.id, "pipelineId": w.pipeline_id,
            "weldNo": w.weld_no, "betweenA": w.between_a, "betweenB": w.between_b,
            "type": w.type, "procedure": getattr(w, 'procedure', ''),
            "weldingWire": w.welding_wire, "welder": w.welder, "inspector": w.inspector,
            "welderId": w.welder_id, "inspectorId": w.inspector_id,
            "date": w.date, "endoscopyVideoUrl": w.endoscopy_video_url,
            "endoscopyImageUrl": w.endoscopy_image_url, "remarks": w.remarks,
            "archived": w.archived,
        })

    project_materials = []
    for pm in pm_rows:
        project_materials.append({
            "id": pm.id, "projectId": pm.project_id,
            "globalMaterialId": pm.global_material_id,
            "certificate": pm.certificate, "heatNo": pm.heat_no,
            "wazPdfUrl": pm.waz_pdf_url, "archived": pm.archived,
            "category": pm.category, "itemDescription": pm.item_description,
            "dn1": pm.dn1, "dn2": pm.dn2, "dn3": pm.dn3,
            "dn4": pm.dn4, "dn5": pm.dn5, "dn6": pm.dn6,
            "diameter": pm.diameter, "thickness": pm.thickness,
            "surface": pm.surface, "materialCode": pm.material_code,
            "dienNo": pm.dien_no,
        })

    global_materials = []
    for g in gm_rows:
        global_materials.append({
            "id": g.id,
            "category": g.category,
            "itemDescription": g.item_description,
            "dn1": g.dn1, "dn2": g.dn2, "dn3": g.dn3,
            "dn4": g.dn4, "dn5": g.dn5, "dn6": g.dn6,
            "diameter": g.diameter, "thickness": g.thickness,
            "surface": g.surface, "materialCode": g.material_code,
            "dienNo": g.dien_no, "archived": g.archived,
        })

    return jsonify({
        "client": {
            "id": row.c_id, "name": row.c_name, "street": row.street,
            "zipCode": row.zip_code, "location": row.c_location,
            "remarks": row.remarks, "archived": row.c_archived,
        } if row.c_id else None,
        "project": {
            "id": row.pr_id, "clientId": row.client_id, "istProjectNo": row.ist_project_no,
            "title": row.pr_title, "location": row.pr_location, "orderNo": row.order_no,
            "description": row.pr_desc, "status": row.pr_status, "archived": row.pr_archived,
            "sharepointDriveId": row.sharepoint_drive_id,
            "sharepointFolderId": row.sharepoint_folder_id,
            "sharepointFolderUrl": row.sharepoint_folder_url,
        } if row.pr_id else None,
        "pipelines": [{
            "id": s.id, "projectId": s.project_id, "no": s.no, "plant": s.plant,
            "status": s.status, "docIso": s.doc_iso, "docBuilder": s.doc_builder,
            "docFinal": s.doc_final, "weldingStart": s.welding_start,
            "weldingEnd": s.welding_end, "weldingRemarks": s.welding_remarks,
            "archived": s.archived,
        } for s in sib_rows],
        "materials": materials,
        "welds": welds,
        "projectMaterials": project_materials,
        "globalMaterials": global_materials,
        "welders": welders,
    })
