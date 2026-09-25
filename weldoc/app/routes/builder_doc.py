from flask import Blueprint, send_file, jsonify
from app.database import db
from app.models.pipeline import Pipeline
from app.models.project import Project
from app.models.client import Client
from app.models.pipeline_material import PipelineMaterial
from app.models.weld import Weld
from app.models.welder import Welder
from app.dates import fmt_date
from app.routes.pipeline_materials import _letter_to_pos
import openpyxl
from openpyxl.styles import Font, Alignment, Border, Side, PatternFill
from openpyxl.utils import get_column_letter
from openpyxl.drawing.image import Image as XlImage
import io
import os

builder_doc_bp = Blueprint("builder_doc", __name__)


def _result_mark(value):
    """A recorded inspection result as the short mark this form uses.

    The legend at the foot of the sheet defines them: o.k. = In Ordnung, F = Fehler,
    n.a. = nicht Anwendbar. A result that was never recorded stays blank rather than
    claiming anything.
    """
    v = (value or "").strip().lower()
    if v == "ok":
        return "o.k"
    if v == "not ok":
        return "F"
    if v in ("n/a", "na", "n.a."):
        return "n.a."
    return ""


def _cross_out_empty_cells(ws, first_row, last_row, skip_cols, box_border):
    """Draw a diagonal line through every empty cell in the data rows.

    An empty field could be filled in after the document has been signed; a crossed-out one
    cannot. Columns in `skip_cols` are left untouched - those are the boxes ISTinox and the
    customer sign by hand, and they have to stay blank.
    """
    from openpyxl.styles import Border, Side

    struck = Border(left=box_border.left, right=box_border.right,
                    top=box_border.top, bottom=box_border.bottom,
                    diagonal=Side(style="thin"), diagonalDown=True)

    # A merged block holds its value in the top-left cell only; the diagonal has to go on
    # every cell of the block or Excel draws it across just the first column of it.
    merged_of = {}
    for rng in ws.merged_cells.ranges:
        for r in range(rng.min_row, rng.max_row + 1):
            for c in range(rng.min_col, rng.max_col + 1):
                merged_of[(r, c)] = rng

    for r in range(first_row, last_row + 1):
        c = 1
        while c <= 17:
            if c in skip_cols:
                c += 1
                continue
            rng = merged_of.get((r, c))
            if rng:
                value = ws.cell(rng.min_row, rng.min_col).value
                if value in (None, ""):
                    for cc in range(rng.min_col, rng.max_col + 1):
                        if cc not in skip_cols:
                            ws.cell(r, cc).border = struck
                c = rng.max_col + 1
                continue
            if ws.cell(r, c).value in (None, ""):
                ws.cell(r, c).border = struck
            c += 1


XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def _signature_placer(include_welder_sign, include_inspector_sign):
    """Return place(ws, row, weld): puts the welder's and inspector's signature images into
    a weld row - welder in I (Signatur / Short mark), inspector in K (Endoskopie Signatur),
    the same cells the PDF export used. Images are downloaded once per URL."""
    if not (include_welder_sign or include_inspector_sign):
        return None

    from PIL import Image as PILImage
    from openpyxl.drawing.spreadsheet_drawing import OneCellAnchor, AnchorMarker
    from openpyxl.drawing.xdr import XDRPositiveSize2D
    from openpyxl.utils.units import pixels_to_EMU
    from app.routes.export_final import _download_sharepoint_file

    cache = {}  # url -> (bytes, w_px, h_px) or None

    def _load(url):
        if url not in cache:
            cache[url] = None
            content = _download_sharepoint_file(url)
            if content:
                try:
                    w_px, h_px = PILImage.open(io.BytesIO(content)).size
                    cache[url] = (content, w_px, h_px)
                except Exception as ex:
                    from flask import current_app
                    current_app.logger.error(f"Failed to load signature image: {ex}")
        return cache[url]

    def _person_for(person_id, legacy_name):
        if person_id:
            return Welder.query.get(person_id)
        if legacy_name:
            return Welder.query.filter((Welder.name == legacy_name) | (Welder.no == legacy_name)).first()
        return None

    def _put(ws, row, col, url):
        entry = _load(url) if url else None
        if not entry:
            return
        content, w_px, h_px = entry
        # Fit inside the cell with a small margin, keeping the aspect ratio, and centre it.
        cell_w = round(ws.column_dimensions[get_column_letter(col)].width * 7) + 5
        cell_h = (ws.row_dimensions[row].height or 15) * 4 / 3
        max_w, max_h = cell_w - 6, cell_h - 6
        scale = min(max_w / max(w_px, 1), max_h / max(h_px, 1))
        img_w, img_h = max(1, int(w_px * scale)), max(1, int(h_px * scale))
        img = XlImage(io.BytesIO(content))   # a fresh stream per image - openpyxl reads it on save
        img.width, img.height = img_w, img_h
        img.anchor = OneCellAnchor(
            _from=AnchorMarker(col=col - 1, colOff=pixels_to_EMU(int((cell_w - img_w) // 2)),
                               row=row - 1, rowOff=pixels_to_EMU(int((cell_h - img_h) // 2))),
            ext=XDRPositiveSize2D(pixels_to_EMU(img_w), pixels_to_EMU(img_h)))
        ws.add_image(img)

    def place(ws, row, w):
        if include_welder_sign:
            p = _person_for(w.welder_id, w.welder)
            if p and p.signature_url:
                _put(ws, row, 9, p.signature_url)
        if include_inspector_sign:
            p = _person_for(getattr(w, "inspector_id", None), getattr(w, "inspector", None))
            if p and p.signature_url:
                _put(ws, row, 11, p.signature_url)

    return place


@builder_doc_bp.route("/<int:pipeline_id>/builder-doc", methods=["GET"])
def generate_builder_doc(pipeline_id):
    """Welder document (stage 3): the weld inspection list, without signatures."""
    pl, pr, file_bytes = build_weld_list_workbook(pipeline_id)

    # Save to SharePoint: {pipeline_no}/{filename}
    if pr and pr.sharepoint_drive_id and pr.sharepoint_folder_id:
        import threading
        from flask import current_app
        app = current_app._get_current_object()
        drive_id = pr.sharepoint_drive_id
        folder_id = pr.sharepoint_folder_id
        pipe_no = pl.no
        pl_id = pl.id
        content = file_bytes

        def _bg_upload():
            with app.app_context():
                from app.sharepoint import upload_to_pipeline_subfolder
                import logging
                try:
                    url = upload_to_pipeline_subfolder(
                        drive_id, folder_id,
                        pipe_no, "02 Schweissnahtliste",
                        f"{pipe_no}_welder.xlsx", content,
                        XLSX_MIME
                    )
                    if url:
                        pipeline = Pipeline.query.get(pl_id)
                        pipeline.doc_builder = url
                        db.session.commit()
                except Exception as e:
                    logging.getLogger(__name__).error(f"Failed to upload builder doc to SharePoint: {e}")

        threading.Thread(target=_bg_upload, daemon=True).start()

    filename = f"{pl.no}_welder.xlsx"
    return send_file(io.BytesIO(file_bytes), mimetype=XLSX_MIME, as_attachment=True, download_name=filename)


@builder_doc_bp.route("/<int:pipeline_id>/export-final-excel", methods=["GET"])
def export_final_excel(pipeline_id):
    """Final export (stage 5): the same weld inspection list as the welder document, now
    carrying the recorded welding details, with the welder / inspector signatures if asked.

    Replaces the PDF export in the UI; the PDF code in export_final.py is kept, unused.
    """
    from flask import request
    include_welder_sign = request.args.get("include_welder_sign", "true").lower() in ("true", "1", "yes")
    include_inspector_sign = request.args.get("include_inspector_sign", "true").lower() in ("true", "1", "yes")

    pl, pr, file_bytes = build_weld_list_workbook(
        pipeline_id,
        include_welder_sign=include_welder_sign,
        include_inspector_sign=include_inspector_sign,
    )

    filename = f"{pl.no}_final.xlsx"
    if pr and pr.sharepoint_drive_id and pr.sharepoint_folder_id:
        from app.sharepoint import upload_to_pipeline_subfolder
        url = upload_to_pipeline_subfolder(
            pr.sharepoint_drive_id, pr.sharepoint_folder_id,
            pl.no, "Final", filename, file_bytes, XLSX_MIME
        )
        if url:
            pl.doc_final = url

    pl.status = max(pl.status or 0, 5)
    db.session.commit()

    return send_file(io.BytesIO(file_bytes), mimetype=XLSX_MIME, as_attachment=True, download_name=filename)


def build_weld_list_workbook(pipeline_id, include_welder_sign=False, include_inspector_sign=False):
    """Build the weld inspection list workbook. Returns (pipeline, project, xlsx bytes)."""
    place_signatures = _signature_placer(include_welder_sign, include_inspector_sign)
    pl = Pipeline.query.get_or_404(pipeline_id)
    pr = Project.query.get(pl.project_id) if pl.project_id else None
    cli = Client.query.get(pr.client_id) if pr and pr.client_id else None

    raw_materials = (
        PipelineMaterial.query.filter_by(pipeline_id=pipeline_id, archived=False)
        .order_by(db.func.length(PipelineMaterial.position), PipelineMaterial.position)
        .all()
    )

    # Flatten pipeline materials for easy property access
    class MatView:
        def __init__(self, plm):
            pm = plm.project_material
            gm = pm.global_material if pm else None
            self.position = plm.position
            self.start_of_plumbing = plm.start_of_plumbing
            self.end_of_plumbing = plm.end_of_plumbing
            self.waz_no = plm.waz_no
            self.category = gm.category if gm else ""
            self.item_description = gm.item_description if gm else ""
            self.dn1 = gm.dn1 if gm else ""
            self.dn2 = gm.dn2 if gm else ""
            self.diameter = gm.diameter if gm else ""
            self.thickness = gm.thickness if gm else ""
            self.material_code = gm.material_code if gm else ""
            self.dien_no = gm.dien_no if gm else ""
            self.surface = gm.surface if gm else ""
            self.certificate = pm.certificate if pm else ""
            self.heat_no = pm.heat_no if pm else ""

    materials = [MatView(m) for m in raw_materials]
    welds = (
        Weld.query.filter_by(pipeline_id=pipeline_id, archived=False)
        .order_by(Weld.id)
        .all()
    )

    # Build weld lookup: (between_a, between_b) -> weld
    weld_map = {}
    for w in welds:
        if w.between_a and w.between_b:
            weld_map[(w.between_a, w.between_b)] = w
            weld_map[(w.between_b, w.between_a)] = w

    # Build connections per material position
    mat_connections = {}  # position -> [connected positions]
    for w in welds:
        if w.between_a and w.between_b:
            mat_connections.setdefault(w.between_a, []).append(w.between_b)
            mat_connections.setdefault(w.between_b, []).append(w.between_a)

    # Walk combined view order (start -> end). Identical to the combined view on
    # screen: follow one line to its end, queueing every branch met along the way,
    # then drain that queue in the order the branches were found. Descending into a
    # branch the moment it is found (a plain depth-first walk) emits a later
    # junction's branch before an earlier one, which is why this export used to
    # disagree with the screen.
    mat_by_pos = {m.position: m for m in materials}
    start_mat = next((m for m in materials if m.start_of_plumbing), materials[0] if materials else None)

    visited = set()
    combined_rows = []  # list of (type, data, extra) tuples
    branch_queue = []

    def conns_of(pos):
        """Unvisited neighbour positions of `pos`, end pieces last."""
        out = [p for p in mat_connections.get(pos, []) if p not in visited and p in mat_by_pos]
        # End pieces last, then by position: at a tee the run carries on through the
        # lower-lettered leg, so the rows read in letter order. Display only - this
        # picks which way to go first, it changes no position.
        out.sort(key=lambda p: (1 if mat_by_pos[p].end_of_plumbing else 0, _letter_to_pos(p)))
        return out

    def walk_line(start_pos):
        """Follow one line, queueing branches. Returns the last position on it."""
        cur, tail = start_pos, start_pos
        while cur and cur not in visited:
            mat = mat_by_pos.get(cur)
            if not mat:
                break
            visited.add(cur)
            combined_rows.append(("material", mat, None))
            tail = cur
            conns = conns_of(cur)
            if not conns:
                break
            # A pointer row per branch sits directly under the part, naming where
            # that branch ends; the label is only known once the branch is walked.
            for bp in conns[1:]:
                branch_queue.append({"slot": len(combined_rows), "from": cur, "start": bp})
                combined_rows.append(None)
            w = weld_map.get((cur, conns[0]))
            if w:
                combined_rows.append(("weld", w, None))
            cur = conns[0]
        return tail

    def drain_branches():
        while branch_queue:
            # Lowest-lettered branch first, so branches also come out in letter order.
            b = min(branch_queue, key=lambda x: _letter_to_pos(x["start"]))
            branch_queue.remove(b)
            if b["start"] in visited:
                continue  # the None left in its slot is stripped after the walk
            bw = weld_map.get((b["from"], b["start"]))
            if not bw:
                continue
            key = f"{b['from']}->{b['start']}"
            marker = len(combined_rows)
            combined_rows.append(None)
            combined_rows.append(("weld", bw, None))
            tail = walk_line(b["start"])
            combined_rows[marker] = ("branch", b["from"], key)
            combined_rows[b["slot"]] = ("branch", tail, key)

    seeds = ([start_mat] if start_mat else []) + list(materials)
    for seed in seeds:
        if not seed or seed.position in visited:
            continue
        walk_line(seed.position)
        drain_branches()
    combined_rows = [r for r in combined_rows if r is not None]  # unused pointer slots

    # === Generate Excel (A-P = 16 columns) ===
    wb = openpyxl.Workbook()
    ws = wb.active          # rebound per page in the loop further down
    thin = Border(left=Side("thin"), right=Side("thin"), top=Side("thin"), bottom=Side("thin"))
    sf = Font(bold=True, size=10); df = Font(size=10); bf = Font(bold=True, size=10)
    h7 = Font(bold=True, size=8); h6 = Font(bold=True, size=7)
    blue = PatternFill("solid", fgColor="B8CCE4"); grey = PatternFill("solid", fgColor="F2F2F2")
    # Each branch gets its own shade, shared by its two marker rows, so a part
    # with two branches shows two distinguishable pairs.
    BRANCH_COLOURS = ["F8CBAD", "F4B6B6", "FBE2D5", "FAD4D4", "E8C9A0", "F2B27A"]
    _branch_seen = {}
    def branch_fill(key):
        if key not in _branch_seen:
            _branch_seen[key] = BRANCH_COLOURS[len(_branch_seen) % len(BRANCH_COLOURS)]
        return PatternFill("solid", fgColor=_branch_seen[key])
    wc = Alignment(wrap_text=True, vertical="center", horizontal="center")
    wr = Alignment(wrap_text=True, vertical="center")
    rot = Alignment(wrap_text=True, vertical="center", horizontal="center", textRotation=90)
    def bdr(r1,c1,r2,c2):
        for r in range(r1,r2+1):
            for c in range(c1,c2+1): ws.cell(r,c).border = thin
    def fl(r1,c1,r2,c2,f):
        for r in range(r1,r2+1):
            for c in range(c1,c2+1): ws.cell(r,c).fill = f
    # The header is written once per printed page rather than repeated by Excel, because
    # the page number has to differ on each one and no cell formula can know which page it
    # is on. Each block carries its own "Seite / Page: n von N".
    PAGE_ROWS = 10           # rows the header block occupies
    HEADER_HEIGHT = 291      # its height in points, for the page budget below

    def write_header_block(top, page_no, total_pages):
        # ROW 1-2 merged (taller rows)
        ws.row_dimensions[top+0].height = 25
        ws.row_dimensions[top+1].height = 25
        ws.merge_cells(f"A{top+0}:F{top+1}"); ws[f"A{top+0}"]="Hersteller / manufacturer: ISTinox AG"; ws[f"A{top+0}"].font=Font(bold=True,size=12); ws[f"A{top+0}"].alignment=Alignment(wrap_text=True,vertical="center",horizontal="center")
        ws.merge_cells(f"G{top+0}:O{top+1}"); ws[f"G{top+0}"]="Schweissnahtprüfliste"; ws[f"G{top+0}"].font=Font(bold=True,size=18); ws[f"G{top+0}"].alignment=Alignment(horizontal="center",vertical="center")
        ws.merge_cells(f"P{top+0}:Q{top+1}"); ws[f"P{top+0}"]=""; ws[f"P{top+0}"].alignment=wc  # Company logo
        bdr(top+0,1,top+1,17)
        logo_path = os.path.join(os.path.dirname(__file__), '..', '..', 'image.png')
        if os.path.exists(logo_path):
            from openpyxl.drawing.spreadsheet_drawing import OneCellAnchor, AnchorMarker
            from openpyxl.drawing.xdr import XDRPositiveSize2D
            from openpyxl.utils.units import pixels_to_EMU

            img = XlImage(logo_path)
            img.width = 130
            img.height = 45
            # Centred in the merged P:Q block. add_image() pins a picture to the top-left
            # corner of a cell, so without an offset the logo hangs in the upper left of that
            # block instead of sitting in the middle of it.
            block_w = sum(round(ws.column_dimensions[c].width * 7) + 5 for c in ("P", "Q"))
            block_h = (ws.row_dimensions[top+0].height + ws.row_dimensions[top+1].height) * 4 / 3
            img.anchor = OneCellAnchor(
                _from=AnchorMarker(col=15, colOff=pixels_to_EMU(max(0, (block_w - img.width) // 2)),
                                   row=top - 1, rowOff=pixels_to_EMU(max(0, int((block_h - img.height) // 2)))),
                ext=XDRPositiveSize2D(pixels_to_EMU(img.width), pixels_to_EMU(img.height)))
            ws.add_image(img)
        # ROW 3
        ws.merge_cells(f"A{top+2}:C{top+2}"); ws[f"A{top+2}"]="Auftrag - Nr. / Order No.:"; ws[f"A{top+2}"].font=sf
        ws.merge_cells(f"D{top+2}:G{top+2}"); ws[f"D{top+2}"]=pr.order_no if pr else ""; bdr(top+2,4,top+2,7)
        ws.merge_cells(f"H{top+2}:I{top+2}"); ws[f"H{top+2}"]="Kunde / Customer:"; ws[f"H{top+2}"].font=sf
        ws.merge_cells(f"J{top+2}:N{top+2}"); ws[f"J{top+2}"]=cli.name if cli else ""; bdr(top+2,10,top+2,14)
        # "Projekt / project:" labels this row and the project name sits under it in rows 4-5.
        ws.merge_cells(f"O{top+2}:P{top+2}"); ws[f"O{top+2}"]="Projekt / project:"; ws[f"O{top+2}"].font=sf
        # Each printed page is its own worksheet tab, so SHEET() is this page's number and
        # SHEETS() is the total. Excel keeps both up to date by itself - no typing, and it
        # stays right if tabs are added or removed.
        # SHEET() and SHEETS() arrived in Excel 2013, and anything newer than the 2007 set
        # has to be stored with the _xlfn. prefix. Written as plain SHEET() Excel does not
        # recognise the name and the cell shows #NAME?. Excel displays it without the prefix.
        ws[f"Q{top+2}"]='="Seite / Page: "&_xlfn.SHEET()&" von "&_xlfn.SHEETS()'; ws[f"Q{top+2}"].font=df
        # ROW 4-5
        ws.merge_cells(f"A{top+3}:C{top+4}"); ws[f"A{top+3}"]="Rohrleitungs- / Zeichnungs Nr.\nPipeline- / Drawing No."; ws[f"A{top+3}"].font=sf; ws[f"A{top+3}"].alignment=wr
        ws.merge_cells(f"D{top+3}:G{top+4}"); ws[f"D{top+3}"]=pl.no; ws[f"D{top+3}"].font=bf; ws[f"D{top+3}"].alignment=wr; bdr(top+3,4,top+4,7)
        ws.merge_cells(f"H{top+3}:I{top+4}"); ws[f"H{top+3}"]="Schweissverfahren\nWelding procedure:"; ws[f"H{top+3}"].font=sf; ws[f"H{top+3}"].alignment=wr
        # Fixed to WIG on every sheet; changed by hand in the rare case it differs.
        ws.merge_cells(f"J{top+3}:N{top+4}"); ws[f"J{top+3}"]="WIG"; ws[f"J{top+3}"].font=bf; ws[f"J{top+3}"].alignment=wr; bdr(top+3,10,top+4,14)
        # O, P and Q of rows 4-5 are one cell, so the project name runs to the right edge.
        ws.merge_cells(f"O{top+3}:Q{top+4}"); ws[f"O{top+3}"]=pr.title if pr else ""; ws[f"O{top+3}"].font=bf; ws[f"O{top+3}"].alignment=wr
        bdr(top+2,1,top+4,17)
        # ROW 6: the three responsibilities, regrouped - the weld and how it was made,
        # then the welder, then the inspection.
        ws.row_dimensions[top+5].height = 16
        ws.merge_cells(f"A{top+5}:F{top+5}"); ws[f"A{top+5}"]="Schweissnaht & Schweissverfahren / Weld & weld process"; ws[f"A{top+5}"].font=sf
        ws.merge_cells(f"G{top+5}:I{top+5}"); ws[f"G{top+5}"]="Schweisser / Welder"; ws[f"G{top+5}"].font=sf
        ws.merge_cells(f"J{top+5}:Q{top+5}"); ws[f"J{top+5}"]="Prüfer / Tester"; ws[f"J{top+5}"].font=sf
        bdr(top+5,1,top+5,17)
        # ROW 7-8: Weld headers (narrow columns rotated like the IST reference form)
        ws.row_dimensions[top+6].height = 76
        ws.row_dimensions[top+7].height = 50
        bdr(top+6,1,top+7,17)
        ws.merge_cells(f"A{top+6}:A{top+7}"); ws[f"A{top+6}"]="Schweissnaht Nr.\nWeld seams no."; ws[f"A{top+6}"].font=h7; ws[f"A{top+6}"].alignment=rot
        ws.merge_cells(f"B{top+6}:C{top+7}"); ws[f"B{top+6}"]="Zeichnungs Nummer\nDrawing No."; ws[f"B{top+6}"].font=h7; ws[f"B{top+6}"].alignment=wc
        ws.merge_cells(f"D{top+6}:D{top+7}"); ws[f"D{top+6}"]="Wandstärke [mm]\nThickness"; ws[f"D{top+6}"].font=h7; ws[f"D{top+6}"].alignment=rot
        ws.merge_cells(f"E{top+6}:E{top+7}"); ws[f"E{top+6}"]="Status ¹"; ws[f"E{top+6}"].font=h7; ws[f"E{top+6}"].alignment=rot
        ws.merge_cells(f"F{top+6}:F{top+7}"); ws[f"F{top+6}"]="Schweissdraht Material\nWelding wire material"; ws[f"F{top+6}"].font=h7; ws[f"F{top+6}"].alignment=rot
        ws.merge_cells(f"G{top+6}:G{top+7}"); ws[f"G{top+6}"]="Schweisser Nr.\nWelder no."; ws[f"G{top+6}"].font=h7; ws[f"G{top+6}"].alignment=rot
        ws.merge_cells(f"H{top+6}:H{top+7}"); ws[f"H{top+6}"]="Datum\nDate"; ws[f"H{top+6}"].font=h7; ws[f"H{top+6}"].alignment=rot
        ws.merge_cells(f"I{top+6}:I{top+7}"); ws[f"I{top+6}"]="Signatur\nShort mark ⁵"; ws[f"I{top+6}"].font=h7; ws[f"I{top+6}"].alignment=rot
        ws.merge_cells(f"J{top+6}:J{top+7}"); ws[f"J{top+6}"]="Visuell"; ws[f"J{top+6}"].font=h7; ws[f"J{top+6}"].alignment=rot
        ws.merge_cells(f"K{top+6}:L{top+6}"); ws[f"K{top+6}"]="Endoskopie\nEndoscopy"; ws[f"K{top+6}"].font=h7; ws[f"K{top+6}"].alignment=wc
        ws[f"K{top+7}"]="Signatur"; ws[f"K{top+7}"].font=h6; ws[f"K{top+7}"].alignment=rot
        ws[f"L{top+7}"]="Report ²"; ws[f"L{top+7}"].font=h6; ws[f"L{top+7}"].alignment=rot
        ws.merge_cells(f"M{top+6}:N{top+6}"); ws[f"M{top+6}"]="Ferrit Test\nFerrite test ⁴"; ws[f"M{top+6}"].font=h7; ws[f"M{top+6}"].alignment=wc
        ws[f"M{top+7}"]="Signatur"; ws[f"M{top+7}"].font=h6; ws[f"M{top+7}"].alignment=rot
        ws[f"N{top+7}"]="Report ²"; ws[f"N{top+7}"].font=h6; ws[f"N{top+7}"].alignment=rot
        ws.merge_cells(f"O{top+6}:O{top+7}"); ws[f"O{top+6}"]="Geprüft und akzeptiert\ntested and accepted\nDatum / Date\nSignatur / Short mark\nHersteller\nManufacturer"; ws[f"O{top+6}"].font=h6; ws[f"O{top+6}"].alignment=wc
        ws.merge_cells(f"P{top+6}:P{top+7}"); ws[f"P{top+6}"]="Geprüft und akzeptiert\ntested and accepted\nDatum / Date\nSignatur / Short mark\nKunde (Optional)\nCustomer (optional)"; ws[f"P{top+6}"].font=h6; ws[f"P{top+6}"].alignment=wc
        ws.merge_cells(f"Q{top+6}:Q{top+7}"); ws[f"Q{top+6}"]="Bemerkung\nRemarks\n\n(Bild Nr.)\n(Picture No.)"; ws[f"Q{top+6}"].font=h7; ws[f"Q{top+6}"].alignment=wc
        # ROW 9: Material headers - directly above the material rows they describe
        ws.row_dimensions[top+8].height = 50
        fl(top+8,1,top+8,17,blue); bdr(top+8,1,top+8,17)
        ws[f"A{top+8}"]="Teil Nr.\nPart Nr."; ws[f"A{top+8}"].font=h7; ws[f"A{top+8}"].alignment=rot
        ws.merge_cells(f"B{top+8}:E{top+8}"); ws[f"B{top+8}"]="Beschreibung\nDescription"; ws[f"B{top+8}"].font=sf; ws[f"B{top+8}"].alignment=wc
        ws[f"F{top+8}"]="DN"; ws[f"F{top+8}"].font=sf; ws[f"F{top+8}"].alignment=wc
        ws[f"G{top+8}"]="Dimension"; ws[f"G{top+8}"].font=sf; ws[f"G{top+8}"].alignment=wc
        ws[f"H{top+8}"]="Material"; ws[f"H{top+8}"].font=h7; ws[f"H{top+8}"].alignment=rot
        ws[f"I{top+8}"]="Attest\nEN 10204"; ws[f"I{top+8}"].font=h7; ws[f"I{top+8}"].alignment=rot
        ws.merge_cells(f"J{top+8}:N{top+8}"); ws[f"J{top+8}"]="Oberfläche\nSurface"; ws[f"J{top+8}"].font=sf; ws[f"J{top+8}"].alignment=wc
        ws.merge_cells(f"O{top+8}:P{top+8}"); ws[f"O{top+8}"]="Schmelzen/Probe Nr.\nHeat Number"; ws[f"O{top+8}"].font=sf; ws[f"O{top+8}"].alignment=wc
        ws[f"Q{top+8}"]="WAZ Nummer\nAttest Number"; ws[f"Q{top+8}"].font=sf; ws[f"Q{top+8}"].alignment=wc
        # Row 10 separator
        ws.row_dimensions[top+9].height = 4

    # === DATA ROWS ===
    def _clean_thk(v):
        return (v or "").replace(" mm","").replace("mm","")
    def _bare_dn(v):
        # the form prints the bare size ("15"), not the stored "DN 15"
        return (v or "").replace("DN", "").strip()
    def _wire_label(w):
        """The welding wire as its position letter, e.g. "Q".

        The wire is a material in the pipeline like any other, so the form refers to it the
        short way; the full description is already on its own row in the material list.
        """
        name = (getattr(w, 'welding_wire', '') or '').strip()
        if not name:
            return ""
        for m in materials:
            if (m.item_description or '').strip().lower() == name.lower():
                return m.position or name
        return name

    def _weld_thickness(w):
        # thickness of the joined materials (first non-empty)
        for p in (w.between_a, w.between_b):
            m = mat_by_pos.get(p)
            if m and m.thickness:
                return _clean_thk(m.thickness)
        return ""

    def _write_rows(rows, row):
        for item_type, data, extra in rows:
            if item_type == "material":
                m = data
                pos = m.position or ""
                if m.start_of_plumbing: pos = f"{m.position} (START)"
                if m.end_of_plumbing: pos = f"{m.position} (END)"
                dim = ""
                if m.diameter and m.thickness:
                    dim = f"\u00d8{_clean_thk(m.diameter)}x{_clean_thk(m.thickness)}"
                elif m.diameter: dim = m.diameter
                surface = " - ".join(x for x in [m.dien_no, m.surface] if x)
                ws.cell(row,1,pos).font=bf; ws.cell(row,1).alignment=wc
                ws.merge_cells(start_row=row,start_column=2,end_row=row,end_column=5)
                ws.cell(row,2,m.item_description or m.category or "").font=df; ws.cell(row,2).alignment=wr
                ws.cell(row,6,_bare_dn(m.dn1)).font=df; ws.cell(row,6).alignment=wc
                ws.cell(row,7,dim).font=df; ws.cell(row,7).alignment=wc
                ws.cell(row,8,m.material_code or "").font=df; ws.cell(row,8).alignment=wc
                ws.cell(row,9,m.certificate or "").font=df; ws.cell(row,9).alignment=wc
                ws.merge_cells(start_row=row,start_column=10,end_row=row,end_column=14)
                ws.cell(row,10,surface).font=df; ws.cell(row,10).alignment=wc
                ws.merge_cells(start_row=row,start_column=15,end_row=row,end_column=16)
                ws.cell(row,15,m.heat_no or "").font=df; ws.cell(row,15).alignment=wc
                ws.cell(row,17,m.waz_no or "").font=df; ws.cell(row,17).alignment=wc
                fl(row,1,row,17,blue); bdr(row,1,row,17); ws.row_dimensions[row].height = 26; row+=1
            elif item_type == "branch":
                label, key = data, extra
                ws.merge_cells(start_row=row,start_column=1,end_row=row,end_column=17)
                ws.cell(row,1,label or "").font=bf; ws.cell(row,1).alignment=wc
                fl(row,1,row,17,branch_fill(key)); bdr(row,1,row,17)
                ws.row_dimensions[row].height = 18; row+=1
            elif item_type == "weld":
                w = data
                ws.cell(row,1,w.weld_no or "").font=df; ws.cell(row,1).alignment=wc
                ws.merge_cells(start_row=row,start_column=2,end_row=row,end_column=3)
                ws.cell(row,2,pl.no or "").font=df; ws.cell(row,2).alignment=wr
                ws.cell(row,4,_weld_thickness(w)).font=df; ws.cell(row,4).alignment=wc
                ws.cell(row,5,w.type or "").font=df; ws.cell(row,5).alignment=wc
                welder_no = ""
                if w.welder_id:
                    _wldr = Welder.query.get(w.welder_id)
                    if _wldr: welder_no = _wldr.no or _wldr.name or ""
                if not welder_no: welder_no = w.welder or ""
                ws.cell(row,7,welder_no).font=df; ws.cell(row,7).alignment=wc
                ws.cell(row,8,fmt_date(w.date)).font=df; ws.cell(row,8).alignment=wc
                for c in range(9,18): ws.cell(row,c,"").font=df
                # Welding wire, by the position letter of the wire material in this pipeline -
                # the same short reference the combined view uses on screen.
                ws.cell(row,6,_wire_label(w)).font=df; ws.cell(row,6).alignment=wc
                # Recorded inspection results, in the short marks the legend defines.
                ws.cell(row,10,_result_mark(getattr(w, 'visual', None))).font=df; ws.cell(row,10).alignment=wc
                ws.cell(row,12,_result_mark(getattr(w, 'endoscopy', None))).font=df; ws.cell(row,12).alignment=wc
                ws.cell(row,17,w.remarks or "").font=df; ws.cell(row,17).alignment=wr
                bdr(row,1,row,17); ws.row_dimensions[row].height = 24
                if place_signatures:
                    place_signatures(ws, row, w)
                row+=1
        return row

    # Split the rows into printed pages. Each page becomes its own worksheet tab, so the
    # "Seite / Page" cell can carry =SHEET() / =SHEETS() and number itself: within a single
    # tab that cell is one cell and would read the same on every printed page.
    # The budget is conservative on purpose - a tab that ends a little early just looks
    # normal, whereas overfilling one pushes rows onto a second printed page of that tab.
    ROW_HEIGHT = {"material": 26, "weld": 24, "branch": 18}
    PAGE_BUDGET = 400          # points of data rows per tab, after the header block
    pages, cur, used = [], [], 0
    for item in combined_rows:
        h = ROW_HEIGHT.get(item[0], 24)
        if cur and used + h > PAGE_BUDGET:
            pages.append(cur)
            cur, used = [], 0
        cur.append(item)
        used += h
    if cur or not pages:
        pages.append(cur)

    # A field with nothing in it is crossed out, so nobody can write into the document after
    # it has been signed off. The signature boxes are the exception: they are deliberately
    # left blank for ISTinox or the customer to sign by hand.
    SIGNATURE_COLS = {9, 11, 13, 15, 16}   # I Signatur, K Endoskopie, M Ferrit, O Hersteller, P Kunde

    lf = Font(size=6); lfb = Font(size=6, bold=True)
    legend = [
        ("¹ H... Handnaht / Manual weld seam",        "² o.k... In Ordnung",                 "³ R... Reparatur / Repair",  "⁵ Signatur... Bestätigung Visuelle Prüfung /"),
        ("O... Orbitalnaht / Orbital weld seam",           "F... Fehler / Failure",                    "⁴ <3.0%",                    "   acceptance visual test"),
        ("V... Vorfertigung / Prefabrication",             "P... Photo",                               "",                                ""),
        ("M... Montagenaht / Installation weld seam",      "n.a... nicht Anwendbar / not available",   "",                                ""),
    ]

    from openpyxl.worksheet.properties import PageSetupProperties

    for page_idx, page_rows in enumerate(pages, 1):
        # `ws` is read by bdr/fl/write_header_block/_write_rows through the enclosing scope,
        # so rebinding it here points all of them at the tab being built.
        ws = wb.active if page_idx == 1 else wb.create_sheet()
        ws.title = f"Blatt {page_idx}"

        for c, w in {"A":7,"B":16,"C":16,"D":8,"E":8,"F":12,"G":15,"H":10,"I":8,"J":8,
                     "K":8,"L":8,"M":8,"N":8,"O":24,"P":24,"Q":20}.items():
            ws.column_dimensions[c].width = w

        write_header_block(1, page_idx, len(pages))
        first_data_row = 1 + PAGE_ROWS
        row = _write_rows(page_rows, first_data_row)
        _cross_out_empty_cells(ws, first_data_row, row - 1, SIGNATURE_COLS, thin)

        # Footer legend (four groups, matching the IST reference form). Smaller than the
        # table: it explains the abbreviations, it should not compete with the data.
        row += 1
        for c1, c2, c3, c4 in legend:
            ws.merge_cells(start_row=row, start_column=1, end_row=row, end_column=4)
            ws.cell(row, 1, c1).font = lfb
            ws.merge_cells(start_row=row, start_column=10, end_row=row, end_column=12)
            ws.cell(row, 10, c2).font = lf
            ws.merge_cells(start_row=row, start_column=13, end_row=row, end_column=15)
            ws.cell(row, 13, c3).font = lf
            ws.merge_cells(start_row=row, start_column=16, end_row=row, end_column=17)
            ws.cell(row, 16, c4).font = lf
            row += 1

        # Print setup: landscape, all 17 columns on one page width.
        ws.page_setup.orientation = "landscape"
        ws.page_setup.fitToWidth = 1
        ws.page_setup.fitToHeight = 1
        ws.sheet_properties.pageSetUpPr = PageSetupProperties(fitToPage=True)

    # The first tab is the one that opens.
    wb.active = 0

    # Save to memory
    output = io.BytesIO()
    wb.save(output)
    output.seek(0)
    file_bytes = output.getvalue()
    return pl, pr, file_bytes
