"""Generate the final export as a downloadable PDF with internal bookmarks."""

import io
import os
import json
import base64
import urllib.request
import urllib.parse
from flask import Blueprint, send_file, current_app
from app.database import db
from app.models.pipeline import Pipeline
from app.models.project import Project
from app.models.client import Client
from app.models.pipeline_material import PipelineMaterial
from app.models.weld import Weld
from app.models.welder import Welder, Certificate
from app.dates import fmt_date, today_str
from pypdf import PdfWriter, PdfReader

export_bp = Blueprint("export", __name__)


def _download_sharepoint_file(url):
    if not url:
        return None
    try:
        from app.sharepoint import _get_app_token, _ssl_context, GRAPH_BASE
        token = _get_app_token()
        clean_url = url.split("?")[0]
        encoded_url = base64.urlsafe_b64encode(clean_url.encode()).decode().rstrip("=")
        share_id = "u!" + encoded_url
        download_url = f"{GRAPH_BASE}/shares/{share_id}/driveItem/content"
        req = urllib.request.Request(download_url)
        req.add_header("Authorization", f"Bearer {token}")
        with urllib.request.urlopen(req, context=_ssl_context()) as resp:
            return resp.read()
    except Exception as e:
        current_app.logger.error(f"Failed to download SharePoint file: {e}")
        return None


@export_bp.route("/<int:pipeline_id>/export-final", methods=["GET"])
def export_final(pipeline_id):
    from flask import request
    include_welder_sign = request.args.get("include_welder_sign", "true").lower() in ("true", "1", "yes")
    include_inspector_sign = request.args.get("include_inspector_sign", "true").lower() in ("true", "1", "yes")

    pl = Pipeline.query.get_or_404(pipeline_id)
    pr = Project.query.get(pl.project_id) if pl.project_id else None
    cli = Client.query.get(pr.client_id) if pr and pr.client_id else None

    raw_materials = (
        PipelineMaterial.query.filter_by(pipeline_id=pipeline_id, archived=False)
        .order_by(PipelineMaterial.position)
        .all()
    )
    welds = (
        Weld.query.filter_by(pipeline_id=pipeline_id, archived=False)
        .order_by(Weld.id)
        .all()
    )

    materials = []
    for plm in raw_materials:
        pm = plm.project_material
        gm = pm.global_material if pm else None
        materials.append({
            "position": plm.position,
            "waz_no": plm.waz_no or "",
            "category": gm.category if gm else "",
            "item_description": gm.item_description if gm else "",
            "dn1": gm.dn1 if gm else "",
            "diameter": gm.diameter if gm else "",
            "thickness": gm.thickness if gm else "",
            "material_code": gm.material_code if gm else "",
            "dien_no": gm.dien_no if gm else "",
            "surface": gm.surface if gm else "",
            "certificate": pm.certificate if pm else "",
            "heat_no": pm.heat_no if pm else "",
            "waz_pdf_url": pm.waz_pdf_url if pm else "",
            "start_of_plumbing": plm.start_of_plumbing,
            "end_of_plumbing": plm.end_of_plumbing,
        })

    # Unique WAZ docs
    waz_docs = []
    seen_waz = set()
    for m in materials:
        if m["waz_no"] and m["waz_pdf_url"] and m["waz_no"] not in seen_waz:
            seen_waz.add(m["waz_no"])
            waz_docs.append({"waz_no": m["waz_no"], "url": m["waz_pdf_url"], "heat_no": m["heat_no"]})

    # Unique welder certs — use pipeline copy if available
    from app.sharepoint import _sanitize_name
    welder_ids = set()
    for w in welds:
        if w.welder_id:
            welder_ids.add(w.welder_id)
        if w.inspector_id:
            welder_ids.add(w.inspector_id)
    welder_certs = []
    for wid in welder_ids:
        welder = Welder.query.get(wid)
        if welder:
            certs = Certificate.query.filter_by(welder_id=wid, archived=False).all()
            for c in certs:
                if c.pdf_url:
                    # Build pipeline-local URL for the cert copy
                    pipeline_cert_name = f"{welder.no}_{c.cert_no}.pdf"
                    welder_certs.append({"name": welder.name, "no": welder.no, "cert_no": c.cert_no, "url": c.pdf_url, "welder_id": wid})

    # --- Walk order (same as in _generate_table_pdf) ---
    mat_by_pos = {m["position"]: m for m in materials}
    start_mat = next((m for m in materials if m["start_of_plumbing"]), materials[0] if materials else None)
    visited = set()
    combined = []

    def walk(pos):
        if not pos or pos in visited:
            return
        visited.add(pos)
        mat = mat_by_pos.get(pos)
        if not mat:
            return
        combined.append(("mat", mat))
        conns = []
        for w in welds:
            if w.between_a == pos and w.between_b not in visited:
                conns.append((w.between_b, w))
            elif w.between_b == pos and w.between_a not in visited:
                conns.append((w.between_a, w))
        if conns:
            combined.append(("weld", conns[0][1]))
            walk(conns[0][0])
            for bp, bw in conns[1:]:
                combined.append(("weld", bw))
                walk(bp)

    if start_mat:
        walk(start_mat["position"])
    for m in materials:
        if m["position"] not in visited:
            walk(m["position"])

    # --- Generate builder table PDF with row position tracking ---
    table_pdf, row_positions = _generate_table_pdf(
        pl, pr, cli, materials, welds,
        include_welder_sign=include_welder_sign,
        include_inspector_sign=include_inspector_sign
    )

    # --- Build final PDF with bookmarks ---
    writer = PdfWriter()

    # Add table pages
    table_reader = PdfReader(io.BytesIO(table_pdf))
    for page in table_reader.pages:
        writer.add_page(page)

    # Add ISO drawing if available
    if pl.doc_iso:
        iso_content = _download_sharepoint_file(pl.doc_iso)
        if iso_content:
            try:
                iso_reader = PdfReader(io.BytesIO(iso_content))
                iso_page_num = len(writer.pages)
                for page in iso_reader.pages:
                    writer.add_page(page)
                writer.add_outline_item("ISO Drawing", iso_page_num)
            except Exception:
                pass

    # Add WAZ cover pages + PDFs with bookmarks
    from app.waz_cover import generate_waz_cover_page

    # Track destination pages for WAZ and certs
    waz_page_map = {}
    cert_page_map = {}

    from flask import session as flask_session
    user_name = flask_session.get("user", {}).get("name", "") if flask_session else ""

    for waz in waz_docs:
        mat = next((m for m in materials if m["waz_no"] == waz["waz_no"]), {})
        cover_data = {
            "user_name": user_name, "date": today_str(),
            "client_name": cli.name if cli else "",
            "client_street": cli.street or "" if cli else "",
            "client_zip": cli.zip_code or "" if cli else "",
            "client_place": cli.location or "" if cli else "",
            "order_no": pr.order_no or "" if pr else "",
            "project_title": pr.title or "" if pr else "",
            "location_zip": "", "location_place": pr.location or "" if pr else "",
            "project_no_ist": pr.ist_project_no or "" if pr else "",
            "pipeline_no": pl.no, "waz_no": waz["waz_no"],
            "item_description": mat.get("item_description", ""),
            "norm": mat.get("dien_no", ""), "dn": mat.get("dn1", ""),
            "diameter": mat.get("diameter", ""), "thickness": mat.get("thickness", ""),
            "surface": mat.get("surface", ""), "heat_no": waz["heat_no"],
        }
        cover_pdf = generate_waz_cover_page(cover_data)
        cover_reader = PdfReader(io.BytesIO(cover_pdf))
        page_num = len(writer.pages)
        waz_page_map[waz["waz_no"]] = page_num
        for page in cover_reader.pages:
            writer.add_page(page)
        writer.add_outline_item(f"WAZ {waz['waz_no']}", page_num)

        waz_content = _download_sharepoint_file(waz["url"])
        if waz_content:
            try:
                waz_reader = PdfReader(io.BytesIO(waz_content))
                for page in waz_reader.pages:
                    writer.add_page(page)
            except Exception:
                pass

    for cert in welder_certs:
        cert_content = _download_sharepoint_file(cert["url"])
        if cert_content:
            try:
                cert_reader = PdfReader(io.BytesIO(cert_content))
                page_num = len(writer.pages)
                if cert["welder_id"] not in cert_page_map:
                    cert_page_map[cert["welder_id"]] = page_num
                for page in cert_reader.pages:
                    writer.add_page(page)
                writer.add_outline_item(f"Cert: {cert['name']} - {cert['cert_no']}", page_num)
            except Exception:
                pass

    # --- Add internal GoTo links using exact row positions ---
    from pypdf.generic import ArrayObject, DictionaryObject, NumberObject, NameObject, RectangleObject

    if row_positions:
        for rp in row_positions:
            page_idx = rp.get("page_idx", 0)
            if page_idx >= len(writer.pages):
                continue
            page_obj = writer.pages[page_idx]

            dest_page = None
            if rp["type"] == "mat" and rp.get("waz_no") and rp["waz_no"] in waz_page_map:
                dest_page = waz_page_map[rp["waz_no"]]
                x1, x2 = rp["waz_x1"], rp["waz_x2"]
            elif rp["type"] == "weld" and rp.get("welder_id") and rp["welder_id"] in cert_page_map:
                dest_page = cert_page_map[rp["welder_id"]]
                x1, x2 = rp["welder_x1"], rp["welder_x2"]
            else:
                continue

            if dest_page is not None and dest_page < len(writer.pages):
                if "/Annots" not in page_obj:
                    page_obj[NameObject("/Annots")] = ArrayObject()

                dest_page_ref = writer.pages[dest_page].indirect_reference
                annot = writer._add_object(DictionaryObject({
                    NameObject("/Type"): NameObject("/Annot"),
                    NameObject("/Subtype"): NameObject("/Link"),
                    NameObject("/Rect"): RectangleObject([x1, rp["y_bot"], x2, rp["y_top"]]),
                    NameObject("/Border"): ArrayObject([NumberObject(0), NumberObject(0), NumberObject(0)]),
                    NameObject("/Dest"): ArrayObject([dest_page_ref, NameObject("/Fit")]),
                }))
                page_obj["/Annots"].append(annot)

    # Update pipeline status to 5 (exported)
    pl.status = max(pl.status or 0, 5)

    # Write final PDF
    output = io.BytesIO()
    writer.write(output)
    pdf_bytes = output.getvalue()

    # Upload to SharePoint
    filename = f"{pl.no}_final.pdf"
    if pr.sharepoint_drive_id and pr.sharepoint_folder_id:
        from app.sharepoint import upload_to_pipeline_subfolder
        url = upload_to_pipeline_subfolder(
            pr.sharepoint_drive_id, pr.sharepoint_folder_id,
            pl.no, "Final", filename, pdf_bytes, "application/pdf"
        )
        if url:
            pl.doc_final = url

    db.session.commit()

    return send_file(io.BytesIO(pdf_bytes), mimetype="application/pdf", as_attachment=True, download_name=filename)


def _generate_table_pdf(pl, pr, cli, materials, welds, include_welder_sign=True, include_inspector_sign=True):
    """Generate the builder table as landscape PDF and return (pdf_bytes, row_positions)."""
    from reportlab.lib.pagesizes import A4, landscape
    from reportlab.lib.units import mm
    from reportlab.lib import colors
    from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.enums import TA_CENTER
    from reportlab.pdfgen import canvas as rl_canvas
    from PIL import Image as PILImage
    from reportlab.platypus import Image as RLImage

    LOGO_PATH = os.path.join(os.path.dirname(__file__), '..', '..', 'image.png')
    page_size = landscape(A4)
    blue_bg = colors.HexColor("#B8CCE4")

    styles = getSampleStyleSheet()
    s7 = ParagraphStyle('s7', parent=styles['Normal'], fontSize=8, leading=9.5)
    s7b = ParagraphStyle('s7b', parent=styles['Normal'], fontSize=8, leading=9.5, fontName='Helvetica-Bold')
    s7c = ParagraphStyle('s7c', parent=styles['Normal'], fontSize=8, leading=9.5, alignment=TA_CENTER)
    s7bc = ParagraphStyle('s7bc', parent=styles['Normal'], fontSize=8, leading=9.5, fontName='Helvetica-Bold', alignment=TA_CENTER)
    s9b = ParagraphStyle('s9b', parent=styles['Normal'], fontSize=10, leading=12, fontName='Helvetica-Bold')
    s14b = ParagraphStyle('s14b', parent=styles['Normal'], fontSize=16, leading=18, fontName='Helvetica-Bold', alignment=TA_CENTER)
    s6bc = ParagraphStyle('s6bc', parent=styles['Normal'], fontSize=6.5, leading=7.5, fontName='Helvetica-Bold', alignment=TA_CENTER)

    # Teil | Beschreibung (3 cols, = Wandstärke on weld rows) | DN | Dim | Material/Datum
    # | Attest/Signatur | Oberfläche (5 cols) | Heat (2 cols) | WAZ
    # Cols 7/9/11 hold signature images on weld rows, so they get extra width.
    col_weights = [11, 13, 13, 10, 8, 14, 13, 13, 14, 12, 8, 12, 8, 15, 15, 14]
    total_w = page_size[0] - 24*mm
    _wsum = float(sum(col_weights))
    col_widths = [w/_wsum*total_w for w in col_weights]
    margin = 12*mm

    # Cache the downloaded bytes and the fitted size, not the flowable itself —
    # a ReportLab flowable must not be shared between table cells.
    sig_cache = {}
    def _get_sig_image(url):
        if not url:
            return ""
        if url not in sig_cache:
            sig_cache[url] = None
            content = _download_sharepoint_file(url)
            if content:
                try:
                    pil_img = PILImage.open(io.BytesIO(content))
                    w_px, h_px = pil_img.size
                    aspect = w_px / max(h_px, 1)
                    # Signature cell is ~17mm wide (see col_weights); fill it while
                    # keeping the aspect ratio, capped so rows stay a sane height.
                    max_w, max_h = 15 * mm, 6 * mm
                    if aspect > (max_w / max_h):
                        final_w, final_h = max_w, max_w / aspect
                    else:
                        final_h, final_w = max_h, max_h * aspect
                    sig_cache[url] = (content, final_w, final_h)
                except Exception as ex:
                    current_app.logger.error(f"Failed to load signature image: {ex}")
        entry = sig_cache.get(url)
        if not entry:
            return ""
        content, final_w, final_h = entry
        return RLImage(io.BytesIO(content), width=final_w, height=final_h)

    # Column x offsets relative to the table origin (fallback if a chunk
    # somehow has no _colpositions); the real values come from the draw hook.
    col_x = [0.0]
    for cw in col_widths:
        col_x.append(col_x[-1] + cw)
    REPEAT_ROWS = 4

    # Walk order
    mat_by_pos = {m["position"]: m for m in materials}
    start_mat = next((m for m in materials if m["start_of_plumbing"]), materials[0] if materials else None)
    visited = set()
    combined = []

    def walk(pos):
        if not pos or pos in visited:
            return
        visited.add(pos)
        mat = mat_by_pos.get(pos)
        if not mat:
            return
        combined.append(("mat", mat))
        conns = []
        for w in welds:
            if w.between_a == pos and w.between_b not in visited:
                conns.append((w.between_b, w))
            elif w.between_b == pos and w.between_a not in visited:
                conns.append((w.between_a, w))
        if conns:
            combined.append(("weld", conns[0][1]))
            walk(conns[0][0])
            for bp, bw in conns[1:]:
                combined.append(("weld", bw))
                walk(bp)

    if start_mat:
        walk(start_mat["position"])
    for m in materials:
        if m["position"] not in visited:
            walk(m["position"])

    # Build rows + track metadata
    mat_hdr = [Paragraph("Teil Nr.<br/>Part Nr.", s7bc), Paragraph("Beschreibung<br/>Description", s7bc), "", "",
               Paragraph("DN", s7bc), Paragraph("Dimension", s7bc), Paragraph("Material", s7bc),
               Paragraph("Attest<br/>EN 10204", s7bc), Paragraph("Oberfläche<br/>Surface", s7bc), "", "", "", "",
               Paragraph("Schmelzen/Probe Nr.<br/>Heat Number", s7bc), "", Paragraph("WAZ Nummer<br/>Attest Number", s7bc)]
    row7 = [Paragraph("<b>Rohrschlosser / Pipe man</b>", s7), "", "", "",
            Paragraph("<b>Schweisser / Welder</b>", s7), "", "", "",
            Paragraph("<b>Prüfer / Tester</b>", s7), "", "", "", "", "", "", ""]
    weld_hdr = [Paragraph("Schweissnaht Nr.<br/>Weld seams no.", s6bc), Paragraph("Zeichnungs Nummer<br/>Drawing No.", s6bc), "",
                Paragraph("Wandstärke<br/>[mm]", s6bc), Paragraph("Status", s7bc), Paragraph("Schweisser Nr.<br/>Welder no.", s6bc),
                Paragraph("Datum<br/>Date", s7bc), Paragraph("Signatur<br/>Short mark", s6bc), Paragraph("Visuell", s7bc),
                Paragraph("Endoskopie<br/>Endoscopy", s6bc), "", Paragraph("Ferrit Test<br/>Ferrite test", s6bc), "",
                Paragraph("Geprüft<br/>Hersteller", s6bc), Paragraph("Geprüft<br/>Kunde", s6bc), Paragraph("Bemerkung<br/>Remarks", s6bc)]
    weld_sub = ["", "", "",
                "", "", "",
                "", "", "",
                Paragraph("Signatur", s6bc), Paragraph("Report", s6bc), Paragraph("Signatur", s6bc), Paragraph("Report", s6bc),
                "", "", ""]

    all_rows = [mat_hdr, row7, weld_hdr, weld_sub]
    row_meta = [None, None, None, None]  # no links on header rows

    for item_type, data in combined:
        if item_type == "mat":
            m = data
            pos = m["position"] or ""
            if m["start_of_plumbing"]: pos += " (S)"
            if m["end_of_plumbing"]: pos += " (E)"
            dim = ""
            if m["diameter"] and m["thickness"]:
                dim = f"\u00d8{m['diameter'].replace(' mm','').replace('mm','')}x{m['thickness'].replace(' mm','').replace('mm','')}"
            elif m["diameter"]: dim = m["diameter"]
            surface = " - ".join(x for x in [m["dien_no"], m["surface"]] if x)
            # the form prints the bare size ("15"), not the stored "DN 15"
            dn_bare = (m["dn1"] or "").replace("DN", "").strip()
            waz_text = f'<font color="#0066CC"><b>{m["waz_no"]}</b></font>' if m["waz_no"] else ""
            row = [Paragraph(f"<b>{pos}</b>", s7c), Paragraph(m["item_description"] or m["category"] or "", s7), "", "",
                   Paragraph(dn_bare, s7c), Paragraph(dim, s7c), Paragraph(m["material_code"], s7c),
                   Paragraph(m["certificate"], s7c), Paragraph(surface, s7c), "", "", "", "",
                   Paragraph(m["heat_no"] or "", s7c), "", Paragraph(waz_text, s7c)]
            all_rows.append(row)
            row_meta.append({"type": "mat", "waz_no": m["waz_no"]})
        elif item_type == "weld":
            w = data
            welder_no_str = ""
            welder_sig_img = ""
            inspector_sig_img = ""

            if w.welder_id:
                _wldr = Welder.query.get(w.welder_id)
                if _wldr:
                    welder_no_str = _wldr.no or _wldr.name or ""
                    if include_welder_sign and _wldr.signature_url:
                        welder_sig_img = _get_sig_image(_wldr.signature_url)
            elif w.welder:
                welder_no_str = w.welder

            if include_inspector_sign:
                insp_id = getattr(w, 'inspector_id', None)
                if insp_id:
                    _insp = Welder.query.get(insp_id)
                    if _insp and _insp.signature_url:
                        inspector_sig_img = _get_sig_image(_insp.signature_url)
                elif getattr(w, 'inspector', None):
                    _insp = Welder.query.filter((Welder.name == w.inspector) | (Welder.no == w.inspector)).first()
                    if _insp and _insp.signature_url:
                        inspector_sig_img = _get_sig_image(_insp.signature_url)

            wn_display = f'<font color="#0066CC">{welder_no_str}</font>' if welder_no_str else "\u2014"
            weld_thk = ""
            for _p in (w.between_a, w.between_b):
                _m = mat_by_pos.get(_p)
                if _m and _m.get("thickness"):
                    weld_thk = _m["thickness"].replace(" mm","").replace("mm","")
                    break
            row = [
                Paragraph(w.weld_no or "", s7c),
                Paragraph(pl.no or "", s7), "",
                Paragraph(weld_thk, s7c),
                Paragraph(w.type or "", s7c),
                Paragraph(wn_display, s7c),
                Paragraph(fmt_date(w.date), s7c),
                welder_sig_img or "",
                Paragraph("o.k" if w.remarks and "not" not in w.remarks.lower() else "", s7c),
                inspector_sig_img or "",
                Paragraph("o.k" if getattr(w, 'endoscopy_image_url', None) or getattr(w, 'endoscopy_video_url', None) else "", s7c),
                "", "",
                "", "",
                Paragraph(w.remarks or "", s7)
            ]
            all_rows.append(row)
            row_meta.append({"type": "weld", "welder_id": w.welder_id})

    # Only the weld table's own draw positions may feed the link rects, so it
    # gets its own class: the header tables are 16 columns wide too, and Table
    # splitting rebuilds chunks via self.__class__, so the subclass survives.
    chunks_info = []

    class _LinkTable(Table):
        def drawOn(self, canvas, x, y, _sW=0):
            chunks_info.append({
                "page_idx": getattr(canvas, '_pageNumber', 1) - 1,
                "x": self._hAlignAdjust(x, _sW),
                "y": y,
                "colpositions": list(getattr(self, '_colpositions', None) or col_x),
                "rowpositions": list(self._rowpositions),
                "chunk_rows": len(self._cellvalues),
            })
            return Table.drawOn(self, canvas, x, y, _sW)

    # Build the data table
    data_table = _LinkTable(all_rows, colWidths=col_widths, repeatRows=REPEAT_ROWS)
    style_cmds = [
        ('GRID', (0,0), (-1,-1), 0.5, colors.black),
        ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
        ('TOPPADDING', (0,0), (-1,-1), 1), ('BOTTOMPADDING', (0,0), (-1,-1), 1),
        ('LEFTPADDING', (0,0), (-1,-1), 2), ('RIGHTPADDING', (0,0), (-1,-1), 2),
        ('BACKGROUND', (0,0), (-1,0), blue_bg),
        ('BACKGROUND', (0,2), (-1,3), colors.HexColor("#F2F2F2")),
        ('SPAN', (1,0), (3,0)), ('SPAN', (8,0), (12,0)), ('SPAN', (13,0), (14,0)),
        ('SPAN', (0,1), (3,1)), ('SPAN', (4,1), (7,1)), ('SPAN', (8,1), (15,1)),
        ('SPAN', (1,2), (2,3)),  # Drawing No spans 2 rows
        ('SPAN', (0,2), (0,3)),  # Naht Nr spans 2 rows
        ('SPAN', (3,2), (3,3)),  # Wandstärke spans 2 rows
        ('SPAN', (4,2), (4,3)),  # Status spans 2 rows
        ('SPAN', (5,2), (5,3)),  # Schweisser spans 2 rows
        ('SPAN', (6,2), (6,3)),  # Datum spans 2 rows
        ('SPAN', (7,2), (7,3)),  # Signatur spans 2 rows
        ('SPAN', (8,2), (8,3)),  # Visuell spans 2 rows
        ('SPAN', (9,2), (10,2)),  # Endoskopie header spans 2 cols
        ('SPAN', (11,2), (12,2)),  # Ferrit header spans 2 cols
        ('SPAN', (13,2), (13,3)),  # Hersteller spans 2 rows
        ('SPAN', (14,2), (14,3)),  # Kunde spans 2 rows
        ('SPAN', (15,2), (15,3)),  # Bemerkung spans 2 rows
    ]
    for i, meta in enumerate(row_meta):
        if meta and meta["type"] == "mat":
            style_cmds.append(('BACKGROUND', (0,i), (-1,i), blue_bg))
            style_cmds.append(('SPAN', (1,i), (3,i)))
            style_cmds.append(('SPAN', (8,i), (12,i)))
            style_cmds.append(('SPAN', (13,i), (14,i)))
        elif meta and meta["type"] == "weld":
            style_cmds.append(('SPAN', (1,i), (2,i)))
    data_table.setStyle(TableStyle(style_cmds))

    # Build header elements
    elements = []
    if os.path.exists(LOGO_PATH):
        from reportlab.platypus import Image as RLImage
        logo = RLImage(LOGO_PATH, width=35*mm, height=12*mm)
    else:
        logo = ""
    row1 = [Paragraph("Hersteller / manufacturer: ISTinox AG", s9b)] + [""]*5 + [Paragraph("Schweissnahtpr\u00fcfliste", s14b)] + [""]*7 + [logo, ""]
    hdr_table = Table([row1], colWidths=col_widths, rowHeights=[14*mm])
    hdr_table.setStyle(TableStyle([
        ('SPAN', (0,0), (5,0)),
        ('SPAN', (6,0), (13,0)),
        ('SPAN', (14,0), (15,0)),
        ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
    ]))
    elements.append(hdr_table)

    row3 = [Paragraph("Auftrag - Nr. / Order No.:", s7b), "", "",
            Paragraph(f"<b>{pr.order_no if pr else ''}</b>", s7), "", "",
            Paragraph("Kunde / Customer:", s7b), "",
            Paragraph(f"<b>{cli.name if cli else ''}</b>", s7), "", "", "", "",
            Paragraph(f"Projekt / project: <b>{pr.title if pr else ''}</b>", s7), "",
            Paragraph("Seite / Page: 1", s7)]
    t3 = Table([row3], colWidths=col_widths)
    t3.setStyle(TableStyle([('BOX', (0,0), (-1,-1), 0.5, colors.black), ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
        ('SPAN', (0,0), (2,0)), ('SPAN', (3,0), (5,0)), ('SPAN', (6,0), (7,0)), ('SPAN', (8,0), (12,0)), ('SPAN', (13,0), (14,0))]))
    elements.append(t3)

    row4 = [Paragraph("Rohrleitungs- / Zeichnungs Nr. / Pipeline- / Drawing No.", s7b), "", "",
            Paragraph(f"<b>{pl.no}</b>", s7b), "", "",
            Paragraph("Schweissverfahren / Welding procedure:", s7b), "",
            "", "", "", "", "",
            Paragraph("Schweisszusatzmaterial mit Chargen Nr. / Welding additional material:", s7b), "", ""]
    t4 = Table([row4], colWidths=col_widths)
    t4.setStyle(TableStyle([('BOX', (0,0), (-1,-1), 0.5, colors.black), ('VALIGN', (0,0), (-1,-1), 'MIDDLE'),
        ('SPAN', (0,0), (2,0)), ('SPAN', (3,0), (5,0)), ('SPAN', (6,0), (7,0)), ('SPAN', (8,0), (12,0)), ('SPAN', (13,0), (14,0))]))
    elements.append(t4)
    elements.append(Spacer(1, 1*mm))
    elements.append(data_table)
    elements.append(Spacer(1, 3*mm))
    elements.append(Paragraph(
        "<b>H</b>=Handnaht/Manual  <b>O</b>=Orbital  <b>V</b>=Vorfertigung/Prefabrication  <b>M</b>=Montage/Installation  |  "
        "o.k.=In Ordnung  F=Fehler/Failure  P=Photo  n.a.=nicht Anwendbar  |  "
        "R=Reparatur/Repair  Ferrit &lt;3.0%  |  Signatur=Bestätigung Visuelle Prüfung / acceptance visual test", s7))
    if pl.welding_start or pl.welding_end:
        elements.append(Spacer(1, 2*mm))
        dash = "\u2014"
        ws = fmt_date(pl.welding_start) or dash
        we = fmt_date(pl.welding_end) or dash
        elements.append(Paragraph(f"Schweissen: {ws} \u2013 {we}", s9b))

    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=page_size, leftMargin=margin, rightMargin=margin, topMargin=margin, bottomMargin=margin)
    doc.build(elements)

    # Build row_positions from all captured chunks across all pages
    row_positions = []
    next_global_row = 0
    for chunk_idx, chunk in enumerate(chunks_info):
        draw_x = chunk["x"]
        draw_y = chunk["y"]
        rowpos = chunk["rowpositions"]
        colpos = chunk["colpositions"]
        chunk_rows = chunk["chunk_rows"]

        # Chunks after the first repeat the 4 header rows (repeatRows).
        start_local = 0 if chunk_idx == 0 else REPEAT_ROWS

        for local_i in range(start_local, chunk_rows):
            global_i = next_global_row + (local_i - start_local)

            if global_i >= len(row_meta):
                break
            meta = row_meta[global_i]
            if not meta or local_i >= len(rowpos) - 1:
                continue

            entry = {
                "page_idx": chunk["page_idx"],
                "type": meta["type"],
                # rowpositions[i] is the top edge of row i, measured from the
                # table origin passed to drawOn.
                "y_top": draw_y + rowpos[local_i],
                "y_bot": draw_y + rowpos[local_i + 1],
            }
            if meta["type"] == "mat":
                entry["waz_no"] = meta.get("waz_no", "")
                entry["waz_x1"] = draw_x + colpos[15]  # WAZ column
                entry["waz_x2"] = draw_x + colpos[16]
            elif meta["type"] == "weld":
                entry["welder_id"] = meta.get("welder_id")
                entry["welder_x1"] = draw_x + colpos[5]  # Welder no. column
                entry["welder_x2"] = draw_x + colpos[6]
            row_positions.append(entry)

        next_global_row += (chunk_rows - start_local)

    return buf.getvalue(), row_positions
