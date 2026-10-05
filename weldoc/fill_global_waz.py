"""One-time fill of the global WAZ folder for certificates uploaded before it existed.

For every project material that has a WAZ certificate in its project folder (waz_pdf_url) but
no saved global address yet (waz_global_url, migration 013):
  - the certificate is copied into the global WAZ folder under its file name, unless a file
    of that name is already there (app/global_waz.py: one file per material + heat)
  - the global address is saved on every project material with that file name

Nothing is deleted and no project file changes. Running it again only does what is missing.

    cd weldoc
    venv\\Scripts\\python fill_global_waz.py            # dry run: lists what it would do
    venv\\Scripts\\python fill_global_waz.py --apply    # does it

It uses the database and the SharePoint settings of the .env the app reads
(SHAREPOINT_GLOBAL_WAZ_HOST / _SITE / _FOLDER must be set).
"""
import sys

from app import create_app
from app.database import db
from app.models.project_material import ProjectMaterial


def main(apply):
    app = create_app()
    with app.app_context():
        from app.sharepoint import global_waz_enabled, global_waz_url, global_waz_put
        from app.global_waz import waz_file_name, _download_project_copy, _set_global_url

        cfg = app.config
        print("Database :", db.engine.url.render_as_string(hide_password=True)[:90])
        print("Global   :", cfg.get("SHAREPOINT_GLOBAL_WAZ_HOST"), cfg.get("SHAREPOINT_GLOBAL_WAZ_SITE"),
              "/", cfg.get("SHAREPOINT_GLOBAL_WAZ_FOLDER"))
        print("Mode     :", "APPLY" if apply else "DRY RUN (nothing is written)")
        if not global_waz_enabled():
            print("The global WAZ folder is not configured (SHAREPOINT_GLOBAL_WAZ_FOLDER) - stopping.")
            return 1

        todo = ProjectMaterial.query.filter(
            ProjectMaterial.waz_pdf_url.isnot(None), ProjectMaterial.waz_pdf_url != "",
            ProjectMaterial.waz_global_url.is_(None),
        ).order_by(ProjectMaterial.id).all()
        by_name = {}
        for pm in todo:
            name = waz_file_name(pm)
            if name:
                by_name.setdefault(name, []).append(pm)
        print(f"\n{len(todo)} project material(s) without a global address -> {len(by_name)} file(s)\n")

        found = copied = failed = 0
        for name, pms in sorted(by_name.items()):
            ids = ", ".join(str(p.id) for p in pms)
            url = global_waz_url(name)
            if url:
                action = "already in the global folder - address saved"
                found += 1
            elif not apply:
                action = "would be copied from the project folder"
            else:
                content = None
                for pm in pms:                       # any of them: same material + heat
                    content = _download_project_copy(pm)
                    if content:
                        break
                url = global_waz_put(name, content) if content else None
                if url:
                    action = "copied - address saved"
                    copied += 1
                else:
                    action = "FAILED (project file could not be read or uploaded)"
                    failed += 1
            if apply and url:
                _set_global_url(name, url)
            elif not apply and url:
                action = "already in the global folder - address would be saved"
            print(f"  {name}\n      project material(s) {ids}: {action}")

        print(f"\nDone: {found} already there, {copied} copied, {failed} failed"
              + ("" if apply else "  (dry run - run again with --apply)"))
        left = ProjectMaterial.query.filter(
            ProjectMaterial.waz_pdf_url.isnot(None), ProjectMaterial.waz_pdf_url != "",
            ProjectMaterial.waz_global_url.is_(None)).count()
        print(f"Project materials with a certificate but no global address now: {left}")
        return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main("--apply" in sys.argv))
