from flask import Blueprint, request, jsonify
from app.database import db
from app.models.pipeline import Pipeline
from app.models.project import Project
from app.models.client import Client
from app.sharepoint import create_pipeline_folder

pipelines_bp = Blueprint("pipelines", __name__)


@pipelines_bp.route("", methods=["GET"])
def get_pipelines():
    archived = request.args.get("archived", "false").lower() == "true"
    project_id = request.args.get("projectId", type=int)
    query = Pipeline.query.filter_by(archived=archived)
    if project_id:
        query = query.filter_by(project_id=project_id)
    rows = query.all()
    return jsonify([_serialize(p) for p in rows])


@pipelines_bp.route("/<int:pipeline_id>", methods=["GET"])
def get_pipeline(pipeline_id):
    p = Pipeline.query.get_or_404(pipeline_id)
    return jsonify(_serialize(p))


@pipelines_bp.route("", methods=["POST"])
def create_or_update_pipeline():
    data = request.get_json()
    if "id" in data and data["id"]:
        p = Pipeline.query.get_or_404(data["id"])
        p.project_id = data.get("projectId", p.project_id)
        p.no = data.get("no", p.no)
        p.plant = data.get("plant", p.plant)
        p.status = data.get("status", p.status)
        p.doc_iso = data.get("docIso", p.doc_iso)
        p.doc_builder = data.get("docBuilder", p.doc_builder)
        p.doc_final = data.get("docFinal", p.doc_final)
        if "archived" in data:
            p.archived = data["archived"]
    else:
        p = Pipeline(
            project_id=data["projectId"],
            no=data["no"],
            plant=data.get("plant", ""),
            status=data.get("status", 0),
        )
        db.session.add(p)
        db.session.commit()
        project = Project.query.get(p.project_id)
        client = Client.query.get(project.client_id)
        create_pipeline_folder(client.id, client.name, project.title or project.ist_project_no, project.ist_project_no, p.no)
        return jsonify(_serialize(p)), 200
    db.session.commit()
    return jsonify(_serialize(p)), 200


def _serialize(p):
    return {
        "id": p.id,
        "projectId": p.project_id,
        "no": p.no,
        "plant": p.plant,
        "status": p.status,
        "docIso": p.doc_iso,
        "docBuilder": p.doc_builder,
        "docFinal": p.doc_final,
        "archived": p.archived,
    }
