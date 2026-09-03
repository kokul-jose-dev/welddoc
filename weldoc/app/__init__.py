from flask import Flask, jsonify, send_from_directory, session, redirect, request
from flask_cors import CORS
from app.database import db
from app.routes import register_routes
import os

# Paths that don't require login
PUBLIC_PATHS = {'/', '/login', '/auth/callback', '/logout', '/role.html', '/styles.css', '/app.js'}


def create_app():
    frontend_folder = os.path.join(os.path.dirname(__file__), '..', 'frontend')
    app = Flask(__name__, static_folder=os.path.abspath(frontend_folder), static_url_path='')
    app.config.from_object("app.config.Config")

    CORS(app)
    try:
        from flask_compress import Compress
        Compress(app)
    except ImportError:
        pass
    db.init_app(app)

    with app.app_context():
        try:
            db.create_all()
            # Ensure signature_url column exists in weldoc_welders
            db.session.execute(db.text("ALTER TABLE weldoc_welders ADD signature_url NVARCHAR(500) NULL"))
            db.session.commit()
        except Exception:
            db.session.rollback()

        try:
            # Ensure waz_package_url column exists in weldoc_pipeline_materials
            db.session.execute(db.text("ALTER TABLE weldoc_pipeline_materials ADD waz_package_url NVARCHAR(500) NULL"))
            db.session.commit()
        except Exception:
            db.session.rollback()

        try:
            # Sync existing data: ensure projects and pipelines of archived clients are also archived
            db.session.execute(db.text("""
                UPDATE weldoc_projects
                SET archived = 1
                WHERE client_id IN (SELECT id FROM weldoc_clients WHERE archived = 1)
            """))
            db.session.execute(db.text("""
                UPDATE weldoc_pipelines
                SET archived = 1
                WHERE project_id IN (SELECT id FROM weldoc_projects WHERE archived = 1)
            """))
            db.session.commit()
        except Exception:
            db.session.rollback()

    register_routes(app)

    @app.before_request
    def require_login():
        from flask import request
        if "127.0.0.1" in request.host:
            return redirect(request.url.replace("127.0.0.1", "localhost"))
        path = request.path
        # Allow public paths, API routes, and static assets (css/js/images)
        if path in PUBLIC_PATHS:
            return
        if path.startswith('/api/'):
            return
        if path.startswith('/auth/'):
            return
        # Allow static assets like fonts, images
        if path.endswith(('.css', '.js', '.png', '.jpg', '.svg', '.ico', '.woff', '.woff2')):
            return
        # If not logged in, redirect to login page
        if 'user' not in session:
            return redirect('/')

    @app.route("/")
    def serve_index():
        return send_from_directory(app.static_folder, 'role.html')

    @app.route("/api/sharepoint-config")
    def sharepoint_config():
        return jsonify({
            "host": app.config.get("SHAREPOINT_HOST", ""),
            "sitePath": app.config.get("SHAREPOINT_SITE_PATH", ""),
            "clientId": app.config.get("AZURE_CLIENT_ID", ""),
            "tenantId": app.config.get("AZURE_TENANT_ID", ""),
        })

    @app.route("/api/counts")
    def get_counts():
        """Fast endpoint returning entity counts for sidebar badges in a single SQL round-trip."""
        row = db.session.execute(db.text("""
            SELECT 
                (SELECT COUNT(*) FROM weldoc_clients WHERE archived = 0) as clients,
                (SELECT COUNT(*) FROM weldoc_projects WHERE archived = 0) as projects,
                (SELECT COUNT(*) FROM weldoc_pipelines WHERE archived = 0) as pipelines,
                (SELECT COUNT(*) FROM weldoc_welders WHERE archived = 0) as welders,
                (SELECT COUNT(*) FROM weldoc_global_materials WHERE archived = 0) as materials
        """)).fetchone()
        return jsonify({
            "clients": row.clients if row and row.clients is not None else 0,
            "projects": row.projects if row and row.projects is not None else 0,
            "pipelines": row.pipelines if row and row.pipelines is not None else 0,
            "welders": row.welders if row and row.welders is not None else 0,
            "materials": row.materials if row and row.materials is not None else 0,
        })

    @app.route("/api/bulk")
    def bulk_data():
        """Return multiple datasets in one response to reduce round-trips."""
        import time
        t0 = time.time()
        from app.models.client import Client
        from app.models.project import Project
        from app.models.pipeline import Pipeline
        from app.models.pipeline_material import PipelineMaterial
        from app.models.project_material import ProjectMaterial
        from app.models.global_material import GlobalMaterial
        from app.models.weld import Weld
        from app.models.welder import Welder, Certificate
        from app.routes.clients import _serialize as ser_client
        from app.routes.projects import _serialize as ser_project
        from app.routes.pipelines import _serialize as ser_pipeline
        from app.routes.pipeline_materials import _serialize as ser_plmat
        from app.routes.project_materials import _serialize as ser_projmat
        from app.routes.global_materials import _serialize as ser_gm
        from app.routes.welds import _serialize as ser_weld
        from app.routes.welders import _serialize_welder as ser_welder

        include = request.args.get("include", "").split(",")
        archived = request.args.get("archived", "false").lower() == "true"
        pipeline_id = request.args.get("pipelineId", type=int)
        project_id = request.args.get("projectId", type=int)
        client_id = request.args.get("clientId", type=int)
        result = {}

        # Auto-resolve project from pipeline, client from project with fast scalar queries
        if pipeline_id and not project_id:
            row = db.session.execute(db.text("SELECT project_id FROM weldoc_pipelines WHERE id = :pid"), {"pid": pipeline_id}).fetchone()
            if row:
                project_id = row[0]
        if project_id and not client_id:
            row = db.session.execute(db.text("SELECT client_id FROM weldoc_projects WHERE id = :prid"), {"prid": project_id}).fetchone()
            if row:
                client_id = row[0]

        if "clients" in include:
            t1 = time.time()
            q = Client.query.filter_by(archived=archived)
            if client_id:
                q = q.filter_by(id=client_id)
            result["clients"] = [ser_client(r) for r in q.all()]
            app.logger.info(f"  clients: {time.time()-t1:.3f}s")

        if "projects" in include:
            t1 = time.time()
            q = Project.query.filter_by(archived=archived)
            if project_id:
                q = q.filter_by(id=project_id)
            elif client_id:
                q = q.filter_by(client_id=client_id)
            result["projects"] = [ser_project(r) for r in q.all()]
            app.logger.info(f"  projects: {time.time()-t1:.3f}s")

        if "pipelines" in include:
            t1 = time.time()
            q = Pipeline.query.filter_by(archived=archived)
            if pipeline_id:
                q = q.filter_by(id=pipeline_id)
            elif project_id:
                q = q.filter_by(project_id=project_id)
            result["pipelines"] = [ser_pipeline(r) for r in q.all()]
            app.logger.info(f"  pipelines: {time.time()-t1:.3f}s")

        if "pipelineMaterials" in include:
            t1 = time.time()
            q = PipelineMaterial.query.filter_by(archived=archived)
            if pipeline_id:
                q = q.filter_by(pipeline_id=pipeline_id)
            result["pipelineMaterials"] = [ser_plmat(r) for r in q.order_by(PipelineMaterial.position).all()]
            app.logger.info(f"  pipelineMaterials: {time.time()-t1:.3f}s")

        if "projectMaterials" in include:
            t1 = time.time()
            q = ProjectMaterial.query.filter_by(archived=archived)
            if project_id:
                q = q.filter_by(project_id=project_id)
            result["projectMaterials"] = [ser_projmat(r) for r in q.all()]
            app.logger.info(f"  projectMaterials: {time.time()-t1:.3f}s")

        if "globalMaterials" in include:
            t1 = time.time()
            result["globalMaterials"] = [ser_gm(r) for r in GlobalMaterial.query.filter_by(archived=archived).all()]
            app.logger.info(f"  globalMaterials: {time.time()-t1:.3f}s")

        if "welds" in include:
            t1 = time.time()
            q = Weld.query.filter_by(archived=archived)
            if pipeline_id:
                q = q.filter_by(pipeline_id=pipeline_id)
            result["welds"] = [ser_weld(r) for r in q.all()]
            app.logger.info(f"  welds: {time.time()-t1:.3f}s")

        if "welders" in include:
            t1 = time.time()
            q = Welder.query.filter_by(archived=archived)
            welders = q.all()
            result["welders"] = [ser_welder(w) for w in welders]
            app.logger.info(f"  welders: {time.time()-t1:.3f}s")

        app.logger.info(f"BULK total: {time.time()-t0:.3f}s | include={request.args.get('include','')}")
        return jsonify(result)

    @app.route("/api/sharepoint-token")
    def sharepoint_token():
        """Get an app token for SharePoint (used by the file picker)."""
        import urllib.parse as _up
        import urllib.request as _ur
        import json as _json
        import ssl
        import certifi
        resource = request.args.get("resource", f"https://{app.config.get('SHAREPOINT_HOST', '')}")
        # Ensure resource ends with /.default for v2 endpoint
        scope = resource.rstrip("/") + "/.default"
        try:
            token_url = f"https://login.microsoftonline.com/{app.config['AZURE_TENANT_ID']}/oauth2/v2.0/token"
            data = _up.urlencode({
                "client_id": app.config["AZURE_CLIENT_ID"],
                "client_secret": app.config["AZURE_CLIENT_SECRET"],
                "scope": scope,
                "grant_type": "client_credentials",
            }).encode()
            req = _ur.Request(token_url, data=data, method="POST")
            req.add_header("Content-Type", "application/x-www-form-urlencoded")
            ctx = ssl.create_default_context(cafile=certifi.where())
            with _ur.urlopen(req, context=ctx) as resp:
                result = _json.loads(resp.read())
            return jsonify({"token": result["access_token"]})
        except Exception as e:
            return jsonify({"error": str(e)}), 500

    @app.route("/<path:path>")
    def serve_frontend(path):
        file_path = os.path.join(app.static_folder, path)
        if os.path.isfile(file_path):
            return send_from_directory(app.static_folder, path)
        return jsonify({"error": "not found"}), 404

    with app.app_context():
        db.create_all()

    return app
