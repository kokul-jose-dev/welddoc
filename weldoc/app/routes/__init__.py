from app.routes.clients import clients_bp
from app.routes.projects import projects_bp
from app.routes.pipelines import pipelines_bp
from app.routes.global_materials import global_materials_bp
from app.routes.project_materials import project_materials_bp
from app.routes.pipeline_materials import pipeline_materials_bp
from app.routes.welds import welds_bp
from app.routes.persons import users_bp
from app.routes.builder_doc import builder_doc_bp
from app.routes.export_final import export_bp
from app.routes.auth import auth_bp
from app.routes.welders import welders_bp
from app.routes.wps_processes import wps_processes_bp
from app.routes.pipeline_detail import pipeline_detail_bp
from app.routes.page_views import page_views_bp


def register_routes(app):
    app.register_blueprint(clients_bp, url_prefix="/api/clients")
    app.register_blueprint(projects_bp, url_prefix="/api/projects")
    app.register_blueprint(pipelines_bp, url_prefix="/api/pipelines")
    app.register_blueprint(global_materials_bp, url_prefix="/api/global-materials")
    app.register_blueprint(project_materials_bp, url_prefix="/api/project-materials")
    app.register_blueprint(pipeline_materials_bp, url_prefix="/api/pipeline-materials")
    app.register_blueprint(welds_bp, url_prefix="/api/welds")
    app.register_blueprint(users_bp, url_prefix="/api/users")
    app.register_blueprint(builder_doc_bp, url_prefix="/api/pipelines")
    app.register_blueprint(export_bp, url_prefix="/api/pipelines")
    app.register_blueprint(welders_bp, url_prefix="/api/welders")
    app.register_blueprint(wps_processes_bp, url_prefix="/api/wps-processes")
    app.register_blueprint(pipeline_detail_bp, url_prefix="/api/pipeline-detail")
    app.register_blueprint(page_views_bp, url_prefix="/api/page")
    app.register_blueprint(auth_bp)
