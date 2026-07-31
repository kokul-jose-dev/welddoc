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
    db.init_app(app)

    register_routes(app)

    @app.before_request
    def require_login():
        from flask import request
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
