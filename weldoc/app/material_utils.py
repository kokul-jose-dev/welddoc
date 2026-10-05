import re
from sqlalchemy import func
from app.database import db
from app.models.global_material import GlobalMaterial
from app.models.project_material import ProjectMaterial
from app.models.pipeline_material import PipelineMaterial
from app.spec_values import (canon_certificate, canon_dien,
    canon_dn, canon_diameter, canon_thickness, canon_surface, canon_material_code,
)


def clean_str(val):
    """Clean string: strip leading/trailing whitespace, return '' if None."""
    if val is None:
        return ""
    return str(val).strip()


def clean_dim(val):
    """A diameter in its display form ("33.7"). Refuses anything that is not a number."""
    return canon_diameter(val)


def clean_thk(val):
    """A thickness in its display form ("2.0 mm"). Refuses anything that is not a number."""
    return canon_thickness(val)


def clean_dn(val):
    """A DN in its display form ("DN 25"). Refuses anything that is not a whole number."""
    return canon_dn(val)



def normalize_gm_data(data):
    """Normalize all GlobalMaterial fields from request payload dictionary."""
    cat = clean_str(data.get("category") or data.get("piece"))
    desc = clean_str(data.get("itemDescription") or data.get("item_description") or cat)
    code = canon_material_code(data.get("materialCode") or data.get("material_code"))
    dien = canon_dien(clean_str(data.get("dienNo") or data.get("dien_no")))
    dia = clean_dim(data.get("diameter") or data.get("diameter1"))
    dia2 = clean_dim(data.get("diameter2"))
    dia3 = clean_dim(data.get("diameter3"))
    thk = clean_thk(data.get("thickness") or data.get("thickness1"))
    thk2 = clean_thk(data.get("thickness2"))
    thk3 = clean_thk(data.get("thickness3"))
    surface = canon_surface(data.get("surface"))
    
    dn1 = clean_dn(data.get("dn1") or data.get("dimension"))
    dns = {"dn1": dn1}
    for i in range(2, 7):
        k = f"dn{i}"
        dk = f"dimension{i}"
        val = clean_dn(data.get(k) or data.get(dk))
        dns[k] = val

    return {
        "category": cat,
        "item_description": desc,
        "material_code": code,
        "dien_no": dien,
        "diameter": dia,
        "diameter2": dia2,
        "diameter3": dia3,
        "thickness": thk,
        "thickness2": thk2,
        "thickness3": thk3,
        "surface": surface,
        **dns,
    }


SPEC_FIELDS = (
    "category", "item_description", "material_code", "dien_no", "surface",
    "diameter", "diameter2", "diameter3", "thickness", "thickness2", "thickness3",
    "dn1", "dn2", "dn3", "dn4", "dn5", "dn6",
)


def spec_key(values):
    """The specification as a comparable tuple, from a GlobalMaterial or a normalized dict.

    Number fields are already in one display form on both sides (2 and 2.0 are both
    "2.0 mm"), text fields are compared ignoring case and surrounding spaces.
    """
    get = values.get if isinstance(values, dict) else (lambda k, d=None: getattr(values, k, d))
    return tuple(clean_str(get(f, "")).lower() for f in SPEC_FIELDS)


def find_matching_global_material(norm_data, exclude_id=None):
    """
    Search for an existing active GlobalMaterial with exactly this specification
    (case-insensitive, NULL treated as '').

    Compared in Python rather than SQL: the number columns change type (text -> number)
    with the migration, and comparing their display forms works the same before and after.
    """
    query = GlobalMaterial.query.filter_by(archived=False)
    if exclude_id:
        query = query.filter(GlobalMaterial.id != exclude_id)
    cat = clean_str(norm_data.get("category"))
    if cat:
        # Narrow the candidates on a plain text column first
        query = query.filter(func.lower(func.ltrim(func.rtrim(GlobalMaterial.category))) == cat.lower())
    wanted = spec_key(norm_data)
    for gm in query.order_by(GlobalMaterial.id).all():
        if spec_key(gm) == wanted:
            return gm
    return None


def find_matching_project_material(project_id, global_material_id, certificate, heat_no, exclude_id=None):
    """
    Search for an existing active ProjectMaterial for (project_id, global_material_id, cert, heat)
    case-insensitively and treating NULL as ''.
    """
    cert = canon_certificate(certificate)
    clean_heat = clean_str(heat_no).lower()

    try:
        p_id = int(project_id) if project_id is not None else None
    except Exception:
        p_id = None

    try:
        g_id = int(global_material_id) if global_material_id is not None else None
    except Exception:
        g_id = None

    if p_id is None or g_id is None:
        return None

    query = ProjectMaterial.query.filter(
        ProjectMaterial.project_id == p_id,
        ProjectMaterial.global_material_id == g_id,
        ProjectMaterial.archived == False,
        # a number column: compared as a number, never through text functions
        (ProjectMaterial.certificate == cert) if cert else ProjectMaterial.certificate.is_(None),
        func.lower(func.rtrim(func.ltrim(func.coalesce(ProjectMaterial.heat_no, "")))) == clean_heat,
    )
    if exclude_id is not None and str(exclude_id).isdigit():
        query = query.filter(ProjectMaterial.id != int(exclude_id))

    return query.first()


def merge_global_materials(source_gm_id, target_gm_id):
    """
    Merge source_gm into target_gm:
    1. Re-link all ProjectMaterials from source_gm to target_gm.
    2. If a matching ProjectMaterial already exists under target_gm, merge them.
    3. Archive source_gm.
    """
    if source_gm_id == target_gm_id:
        return

    source_pms = ProjectMaterial.query.filter_by(global_material_id=source_gm_id, archived=False).all()
    for spm in source_pms:
        existing_tpm = find_matching_project_material(
            spm.project_id, target_gm_id, spm.certificate, spm.heat_no, exclude_id=spm.id
        )
        if existing_tpm:
            merge_project_materials(spm.id, existing_tpm.id)
        else:
            spm.global_material_id = target_gm_id

    source_gm = db.session.get(GlobalMaterial, source_gm_id)
    if source_gm:
        source_gm.archived = True


def merge_project_materials(source_pm_id, target_pm_id):
    """
    Merge source_pm into target_pm:
    1. Re-link all PipelineMaterials referencing source_pm to target_pm.
    2. If target has no waz_pdf_url and source does, copy it.
    3. Archive source_pm.
    """
    if source_pm_id == target_pm_id:
        return

    source_pm = db.session.get(ProjectMaterial, source_pm_id)
    target_pm = db.session.get(ProjectMaterial, target_pm_id)

    if not source_pm or not target_pm:
        return

    for row in PipelineMaterial.query.filter_by(project_material_id=source_pm_id).all():
        row.project_material_id = target_pm_id      # one by one, so the event log records it

    if not target_pm.waz_pdf_url and source_pm.waz_pdf_url:
        target_pm.waz_pdf_url = source_pm.waz_pdf_url

    source_pm.archived = True


def check_heat_number_diff(heat_no, form_data, project_id=None, exclude_pm_id=None):
    """
    Check if a heat_no already exists on any active ProjectMaterial.
    If found, compares all specifications against form_data.
    If ANY existing material with this heat_no matches the form_data (0 diffs),
    returns hasDuplicateHeat=False / hasDifferences=False (no conflict).
    Otherwise, returns differences compared to the closest matching material.
    """
    clean_heat = clean_str(heat_no)
    if not clean_heat:
        return {"hasDuplicateHeat": False, "diffs": [], "existingMaterial": None}

    query = (
        db.session.query(ProjectMaterial, GlobalMaterial)
        .join(GlobalMaterial, ProjectMaterial.global_material_id == GlobalMaterial.id)
        .filter(
            ProjectMaterial.archived == False,
            GlobalMaterial.archived == False,
            func.lower(func.rtrim(func.ltrim(func.coalesce(ProjectMaterial.heat_no, "")))) == clean_heat.lower(),
        )
    )
    if exclude_pm_id is not None and str(exclude_pm_id).isdigit():
        query = query.filter(ProjectMaterial.id != int(exclude_pm_id))

    matches = query.all()
    if not matches:
        return {"hasDuplicateHeat": False, "diffs": [], "existingMaterial": None}

    norm = normalize_gm_data(form_data)
    form_cert = canon_certificate(form_data.get("certificate"))

    pid_int = None
    if project_id is not None and str(project_id).isdigit():
        pid_int = int(project_id)

    # Evaluate diffs for each match
    scored_matches = []
    for pm, gm in matches:
        field_map = [
            ("category", "Category", gm.category, norm["category"]),
            ("item_description", "Item Description", gm.item_description, norm["item_description"]),
            ("dn1", "DN / Dimension", gm.dn1, norm["dn1"]),
            ("diameter", "Outer Diameter", gm.diameter, norm["diameter"]),
            ("thickness", "Thickness", gm.thickness, norm["thickness"]),
            ("dien_no", "DIN EN Number", gm.dien_no, norm["dien_no"]),
            ("surface", "Surface", gm.surface, norm["surface"]),
            ("material_code", "Material Code", gm.material_code, norm["material_code"]),
            ("certificate", "Certificate", pm.certificate, form_cert),
        ]
        for i in range(2, 7):
            k = f"dn{i}"
            val_gm = getattr(gm, k, "")
            val_form = norm.get(k, "")
            if val_gm or val_form:
                field_map.append((k, f"DN {i}", val_gm, val_form))

        diffs = []
        for key, label, exist_val, new_val in field_map:
            e_clean = clean_str(exist_val)
            n_clean = clean_str(new_val)
            if e_clean.lower() != n_clean.lower():
                diffs.append({
                    "field": key,
                    "label": label,
                    "existingVal": e_clean,
                    "newVal": n_clean,
                })

        # If any material with this heat number matches identically (0 diffs), there is NO conflict!
        if len(diffs) == 0:
            return {"hasDuplicateHeat": False, "hasDifferences": False, "diffs": [], "existingMaterial": None}

        # Priority: 0 if same project, 1 if other project
        proj_priority = 0 if (pid_int is not None and pm.project_id == pid_int) else 1
        scored_matches.append((len(diffs), proj_priority, pm, gm, diffs))

    # Sort to pick the closest match (fewest differences, then same project)
    scored_matches.sort(key=lambda x: (x[0], x[1]))
    _, _, chosen_pm, chosen_gm, chosen_diffs = scored_matches[0]

    existing_info = {
        "projectMaterialId": chosen_pm.id,
        "globalMaterialId": chosen_gm.id,
        "projectId": chosen_pm.project_id,
        "category": chosen_gm.category or "",
        "itemDescription": chosen_gm.item_description or "",
        "materialCode": chosen_gm.material_code or "",
        "dienNo": chosen_gm.dien_no or "",
        "diameter": chosen_gm.diameter or "",
        "thickness": chosen_gm.thickness or "",
        "surface": chosen_gm.surface or "",
        "dn1": chosen_gm.dn1 or "",
        "certificate": chosen_pm.certificate or "",
        "heatNo": chosen_pm.heat_no or "",
        "wazPdfUrl": chosen_pm.waz_pdf_url or "",
    }
    for i in range(2, 7):
        existing_info[f"dn{i}"] = getattr(chosen_gm, f"dn{i}", "") or ""

    return {
        "hasDuplicateHeat": True,
        "hasDifferences": True,
        "diffs": chosen_diffs,
        "existingMaterial": existing_info,
    }


