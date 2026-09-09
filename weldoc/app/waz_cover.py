"""Generate WAZ cover page PDF matching the Word template layout."""

import io
import os
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor

LOGO_PATH = os.path.join(os.path.dirname(__file__), "..", "image.png")
GREY = HexColor("#666666")
BLACK = HexColor("#000000")


def generate_waz_cover_page(data):
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    w, h = A4
    margin_l = 20 * mm
    margin_r = w - 20 * mm

    # ---- Header: logo top-left ----
    if os.path.exists(LOGO_PATH):
        c.drawImage(LOGO_PATH, margin_l, h - 28 * mm, width=45 * mm, height=18 * mm, preserveAspectRatio=True, mask="auto")

    c.setFont("Helvetica", 7)
    c.setFillColor(GREY)
    rx = margin_r
    ry = h - 18 * mm
    for line in ["IST-Inox AG", "Rötzmattweg 66", "CH-4600 Olten", "Tel +41 62 207 07 07", "www.istinox.ch"]:
        c.drawRightString(rx, ry, line)
        ry -= 3.2 * mm

    # ---- Created by / Date (top-left) ----
    user_name = data.get('user_name', '')
    if not user_name:
        try:
            from flask import session
            user_name = session.get("user", {}).get("name", "") if session else ""
        except Exception:
            user_name = ""

    from app.dates import fmt_date, today_str
    raw_date = data.get('date', '')
    date_str = fmt_date(raw_date) if raw_date else today_str()

    c.setFillColor(BLACK)
    c.setFont("Helvetica", 9)
    y = h - 32 * mm
    c.drawString(margin_l, y, f"Erstellt von:  {user_name}")
    y -= 5 * mm
    c.drawString(margin_l, y, f"Datum: {date_str}")

    # ---- Title ----
    y -= 18 * mm
    c.setFont("Helvetica-Bold", 18)
    c.drawString(margin_l, y, "Werksabnahmezeugnis Deckblatt")

    # ---- Horizontal line ----
    y -= 4 * mm
    c.setStrokeColor(GREY)
    c.setLineWidth(0.5)
    c.line(margin_l, y, margin_r, y)

    # ---- Fields ----
    y -= 12 * mm
    label_x = margin_l
    value_x = margin_l + 48 * mm

    def field(label, value, gap=8):
        nonlocal y
        c.setFont("Helvetica-Bold", 10)
        c.setFillColor(BLACK)
        c.drawString(label_x, y, label)
        c.setFont("Helvetica", 10)
        c.drawString(value_x, y, value or "")
        y -= gap * mm

    def subline(value, gap=6):
        nonlocal y
        c.setFont("Helvetica", 10)
        c.setFillColor(BLACK)
        c.drawString(value_x, y, value or "")
        y -= gap * mm

    field("Kunde:", data.get("client_name", ""))
    subline(data.get("client_street", ""))
    subline(f"{data.get('client_zip', '')} {data.get('client_place', '')}", 10)

    field("Projekt Kunde:", f"{data.get('order_no', '')} {data.get('project_title', '')}", 10)

    field("Standort:", f"{data.get('location_zip', '')} {data.get('location_place', '')}", 10)

    field("Projektnummer IST:", data.get("project_no_ist", ""), 10)

    field("Leitungsnummer:", data.get("pipeline_no", ""), 10)

    field("WAZ Nummer:", data.get("waz_no", ""), 10)

    field("Bezeichnung:", f"{data.get('item_description', '')} {data.get('norm', '')}", 10)

    # DN line
    dn = data.get("dn", "")
    if dn:
        dia = data.get("diameter", "")
        thk = data.get("thickness", "")
        dn_text = dn
        if dia and thk:
            dn_text += f" {dia}x{thk}"
        elif dia:
            dn_text += f" {dia}"
    else:
        dn_text = ""
    field("DN Grösse:", dn_text, 10)

    field("Oberfläche:", data.get("surface", ""), 10)

    field("Schmelzen Nummer:", data.get("heat_no", ""), 16)

    # ---- Footer note ----
    c.setFont("Helvetica-Oblique", 9)
    c.setFillColor(GREY)
    c.drawString(margin_l, y, "Dieses Dokument gilt ohne Unterschrift.")

    c.save()
    return buf.getvalue()
