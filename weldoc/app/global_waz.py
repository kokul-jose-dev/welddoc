"""The global WAZ folder: one copy of every WAZ certificate, whatever project it came from.

A WAZ certificate belongs to a heat of a material, so its file name is the one the project
folder uses (format_waz_filename: description, DN, sizes, material code, surface, heat
number). Projects with the same material and heat therefore share one global file:

  - uploading at project level also uploads it here   (upload_waz_to_project_folder)
  - removing it from a project, or a spec change that renames it, removes the global file
    only when no other project material still uses that name - otherwise the other
    project's certificate would disappear
  - a certificate uploaded before this existed is copied here the first time it is opened
    from the material page (global_url_for)

Where the global copy is, is saved on the project material: waz_global_url (migration 013),
next to waz_pdf_url (the project copy). Every project material with the same file name gets
the same address; clearing waz_pdf_url clears it too (models/project_material.py).

Everything here is best-effort and runs without the request waiting for SharePoint where it
can; a failure is logged, the project-level action is never undone.
"""

import threading

from flask import current_app

from app.database import db
from app.models.project_material import ProjectMaterial


def waz_file_name(pm, gm=None):
    """The WAZ file name of a project material - the same as at project level."""
    from app.sharepoint import format_waz_filename

    gm = gm if gm is not None else pm.global_material
    if gm is None:
        return None
    dns = [getattr(gm, f"dn{i}") for i in range(1, 7) if getattr(gm, f"dn{i}")]
    dias = [d for d in (gm.diameter, gm.diameter2, gm.diameter3) if d]
    thks = [t for t in (gm.thickness, gm.thickness2, gm.thickness3) if t]
    return format_waz_filename(
        item_desc=gm.item_description or "", dn=gm.dn1 or "", diameter=gm.diameter or "",
        thickness=gm.thickness or "", dns=dns, diameters=dias, thicknesses=thks,
        material_code=gm.material_code or "", surface=gm.surface or "", heat_no=pm.heat_no or "",
    )


def names_in_use(exclude_ids=()):
    """File names of the project materials that have a WAZ certificate."""
    rows = ProjectMaterial.query.filter(ProjectMaterial.archived == False,  # noqa: E712
                                        ProjectMaterial.waz_pdf_url.isnot(None),
                                        ProjectMaterial.waz_pdf_url != "").all()
    return {waz_file_name(r) for r in rows if r.id not in set(exclude_ids)} - {None}


def _set_global_url(name, url):
    """Save the global address on every project material whose certificate has this name."""
    if not name:
        return
    rows = ProjectMaterial.query.filter(ProjectMaterial.waz_pdf_url.isnot(None),
                                        ProjectMaterial.waz_pdf_url != "").all()
    changed = False
    for r in rows:
        if waz_file_name(r) == name and r.waz_global_url != url:
            r.waz_global_url = url
            changed = True
    if changed:
        db.session.commit()


def _record(pm_id, content=None, content_type="application/pdf"):
    """After an upload at project level: put the same file into the global WAZ folder and save
    the address it gets. The file that was just uploaded is used as it is; only when it is not
    passed is the project copy read back."""
    from app.sharepoint import global_waz_enabled, global_waz_put

    if not global_waz_enabled():
        return
    db.session.expire_all()
    pm = ProjectMaterial.query.get(pm_id)
    if not pm or not pm.waz_pdf_url:
        return
    name = waz_file_name(pm)
    content = content or _download_project_copy(pm)
    url = global_waz_put(name, content, content_type) if content else None
    if url:
        _set_global_url(name, url)


def after_uploaded(pm, content=None, content_type="application/pdf"):
    """Call after committing a new certificate on a project material, with the file just
    uploaded. The global copy is made in the background - the request does not wait for it."""
    if pm is not None and pm.waz_pdf_url:
        _in_background(_record, pm.id, content, content_type or "application/pdf")


def snapshot(pms):
    """{project material id: file name} for the ones with a certificate - taken before a change."""
    return {pm.id: waz_file_name(pm) for pm in pms if pm.waz_pdf_url}


def _download_project_copy(pm):
    from app.sharepoint import _download_sharepoint_file_content
    try:
        return _download_sharepoint_file_content(pm.waz_pdf_url) if pm.waz_pdf_url else None
    except Exception as e:
        current_app.logger.error(f"global WAZ: could not read the project certificate of {pm.id}: {e}")
        return None


def _apply_renames(before):
    """After a spec change: each certificate under its new name, the old name removed when
    nothing uses it any more."""
    from app.sharepoint import global_waz_enabled, global_waz_put, global_waz_download, global_waz_delete

    if not global_waz_enabled():
        return
    db.session.expire_all()
    olds = set()
    for pm_id, old in before.items():
        pm = ProjectMaterial.query.get(pm_id)
        new = waz_file_name(pm) if pm else None
        if old and old != new:
            olds.add(old)
        if pm and pm.waz_pdf_url and new and new != old:
            content = global_waz_download(old) if old else None
            content = content or _download_project_copy(pm)
            url = global_waz_put(new, content) if content else None
            if url:
                _set_global_url(new, url)
    if olds:
        used = names_in_use()
        for old in olds - used:
            global_waz_delete(old)


def _in_background(fn, *args):
    app = current_app._get_current_object()

    def run():
        with app.app_context():
            try:
                fn(*args)
            except Exception as e:
                app.logger.error(f"global WAZ: {fn.__name__} failed: {e}")
    threading.Thread(target=run, daemon=True).start()


def after_spec_change(before):
    """Call after committing a change that may have renamed certificates (see snapshot)."""
    if before:
        _in_background(_apply_renames, dict(before))


def _remove_if_unused(name):
    from app.sharepoint import global_waz_enabled, global_waz_delete
    if global_waz_enabled() and name and name not in names_in_use():
        global_waz_delete(name)


def after_removed(name):
    """Call after committing the removal of a certificate from a project material."""
    if name:
        _in_background(_remove_if_unused, name)


def global_url_for(pm):
    """The global copy of this project material's certificate - copied there first if it was
    uploaded before the global folder existed. None when there is no certificate at all."""
    from app.sharepoint import global_waz_enabled, global_waz_url, global_waz_put

    if not pm.waz_pdf_url:
        return None
    if not global_waz_enabled():
        return pm.waz_pdf_url             # no global folder configured: the project copy
    if pm.waz_global_url:
        return pm.waz_global_url          # known already - no SharePoint lookup
    name = waz_file_name(pm)
    url = global_waz_url(name)
    if not url:
        content = _download_project_copy(pm)
        url = global_waz_put(name, content) if content else None
    if url:
        _set_global_url(name, url)
    return url or pm.waz_pdf_url
