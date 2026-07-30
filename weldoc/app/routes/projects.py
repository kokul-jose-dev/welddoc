from flask import Blueprint, request, jsonify
from app.database import db
from app.models.project import Project
from app.models.client import Client
from app.sharepoint import create_project_folders

projects_bp = Blueprint("projects", __name__)


@projects_bp.route("", methods=["GET"])
def get_projects():
    archived = request.args.get("archived", "false").lower() == "true"
    client_id = request.args.get("clientId", type=int)
    query = Project.query.filter_by(archived=archived)
    if client_id:
        query = query.filter_by(client_id=client_id)
    rows = query.all()
    return jsonify([_serialize(p) for p in rows])


@projects_bp.route("/<int:project_id>", methods=["GET"])
def get_project(project_id):
    p = Project.query.get_or_404(project_id)
    return jsonify(_serialize(p))


@projects_bp.route("", methods=["POST"])
def create_or_update_project():
    data = request.get_json()
    if "id" in data and data["id"]:
        p = Project.query.get_or_404(data["id"])
        p.client_id = data.get("clientId", p.client_id)
        p.ist_project_no = data.get("istProjectNo", p.ist_project_no)
        p.title = data.get("title", p.title)
        p.location = data.get("location", p.location)
        p.order_no = data.get("orderNo", p.order_no)
        p.description = data.get("description", p.description)
        p.status = data.get("status", p.status)
        if "archived" in data:
            p.archived = data["archived"]
    else:
        p = Project(
            client_id=data["clientId"],
            ist_project_no=data["istProjectNo"],
            title=data.get("title", ""),
            location=data.get("location", ""),
            order_no=data.get("orderNo", ""),
            description=data.get("description", ""),
            status=data.get("status", "Not started"),
        )
        db.session.add(p)
        db.session.commit()
        client = Client.query.get(p.client_id)
        create_project_folders(client.id, client.name, p.title or p.ist_project_no, p.ist_project_no)
        return jsonify(_serialize(p)), 200
    db.session.commit()
    return jsonify(_serialize(p)), 200


def _serialize(p):
    return {
        "id": p.id,
        "clientId": p.client_id,
        "istProjectNo": p.ist_project_no,
        "title": p.title,
        "location": p.location,
        "orderNo": p.order_no,
        "description": p.description,
        "status": p.status,
        "archived": p.archived,
    }
