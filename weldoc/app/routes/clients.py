from flask import Blueprint, request, jsonify
from app.database import db
from app.models.client import Client

clients_bp = Blueprint("clients", __name__)


@clients_bp.route("", methods=["GET"])
def get_clients():
    archived = request.args.get("archived", "false").lower() == "true"
    rows = Client.query.filter_by(archived=archived).all()
    return jsonify([_serialize(c) for c in rows])


@clients_bp.route("/<int:client_id>", methods=["GET"])
def get_client(client_id):
    c = Client.query.get_or_404(client_id)
    return jsonify(_serialize(c))


@clients_bp.route("", methods=["POST"])
def create_or_update_client():
    data = request.get_json()
    if "id" in data and data["id"]:
        c = Client.query.get_or_404(data["id"])
        c.name = data.get("name", c.name)
        c.street = data.get("street", c.street)
        c.zip_code = data.get("zipCode", c.zip_code)
        c.location = data.get("location", c.location)
        c.remarks = data.get("remarks", c.remarks)
        if "archived" in data:
            c.archived = data["archived"]
    else:
        c = Client(
            name=data["name"],
            street=data.get("street", ""),
            zip_code=data.get("zipCode", ""),
            location=data.get("location", ""),
            remarks=data.get("remarks", ""),
        )
        db.session.add(c)
    db.session.commit()
    return jsonify(_serialize(c)), 200


def _serialize(c):
    return {
        "id": c.id,
        "name": c.name,
        "street": c.street,
        "zipCode": c.zip_code,
        "location": c.location,
        "remarks": c.remarks,
        "archived": c.archived,
    }
