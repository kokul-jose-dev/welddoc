"""
SharePoint integration via Microsoft Graph API.
Handles folder creation and file uploads to the weldoc document library.

Folder structure:
  weldoc/
    ClientName_ID/
      ProjectName_ID/
        Pipelines/
          PipelineName/
        Materials/
          HeatNo_CertificateNo.pdf
"""

import json
import urllib.request
import urllib.parse
import ssl
import certifi
from flask import current_app

GRAPH_BASE = "https://graph.microsoft.com/v1.0"


def _ssl_context():
    return ssl.create_default_context(cafile=certifi.where())


def _get_app_token():
    """Get an app-only access token using client credentials flow."""
    cfg = current_app.config
    tenant_id = cfg["AZURE_TENANT_ID"]
    client_id = cfg["AZURE_CLIENT_ID"]
    client_secret = cfg["AZURE_CLIENT_SECRET"]

    token_url = f"https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token"
    data = urllib.parse.urlencode({
        "client_id": client_id,
        "client_secret": client_secret,
        "scope": "https://graph.microsoft.com/.default",
        "grant_type": "client_credentials",
    }).encode()

    req = urllib.request.Request(token_url, data=data, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")

    with urllib.request.urlopen(req, context=_ssl_context()) as resp:
        result = json.loads(resp.read())
    return result["access_token"]


def _get_site_id():
    """Get the SharePoint site ID for the configured site."""
    cfg = current_app.config
    site_host = cfg.get("SHAREPOINT_HOST", "botangelos.sharepoint.com")
    site_path = cfg.get("SHAREPOINT_SITE_PATH", "/sites/Tutorial")

    token = _get_app_token()
    url = f"{GRAPH_BASE}/sites/{site_host}:{site_path}"

    req = urllib.request.Request(url)
    req.add_header("Authorization", f"Bearer {token}")

    with urllib.request.urlopen(req, context=_ssl_context()) as resp:
        result = json.loads(resp.read())
    return result["id"]


def _get_drive_id(site_id):
    """Get the default document library drive ID."""
    token = _get_app_token()
    url = f"{GRAPH_BASE}/sites/{site_id}/drive"

    req = urllib.request.Request(url)
    req.add_header("Authorization", f"Bearer {token}")

    with urllib.request.urlopen(req, context=_ssl_context()) as resp:
        result = json.loads(resp.read())
    return result["id"]


def _create_folder(drive_id, parent_path, folder_name):
    """Create a folder in SharePoint. Returns the folder item or None if it already exists."""
    token = _get_app_token()

    # URL-encode the path for Graph API
    encoded_path = urllib.parse.quote(parent_path, safe="/")
    url = f"{GRAPH_BASE}/drives/{drive_id}/root:/{encoded_path}:/children"

    body = json.dumps({
        "name": folder_name,
        "folder": {},
        "@microsoft.graph.conflictBehavior": "fail"
    }).encode()

    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", "application/json")

    try:
        with urllib.request.urlopen(req, context=_ssl_context()) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        if e.code == 409:
            # Folder already exists — that's fine
            return None
        raise


def _upload_file(drive_id, folder_path, file_name, file_content, content_type="application/pdf"):
    """Upload a file to a SharePoint folder. Returns the file item."""
    token = _get_app_token()

    encoded_path = urllib.parse.quote(f"{folder_path}/{file_name}", safe="/")
    url = f"{GRAPH_BASE}/drives/{drive_id}/root:/{encoded_path}:/content"

    req = urllib.request.Request(url, data=file_content, method="PUT")
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", content_type)

    with urllib.request.urlopen(req, context=_ssl_context()) as resp:
        return json.loads(resp.read())


def _sanitize_name(name):
    """Remove characters not allowed in SharePoint folder/file names."""
    invalid = ['~', '#', '%', '&', '*', '{', '}', '\\', ':', '<', '>', '?', '/', '|', '"']
    for ch in invalid:
        name = name.replace(ch, '_')
    return name.strip().strip('.')


# ---- Public API ----

def create_client_folder(client_id, client_name):
    """Create a folder for a new client: weldoc/ClientName_ID"""
    try:
        site_id = _get_site_id()
        drive_id = _get_drive_id(site_id)
        folder_name = _sanitize_name(f"{client_name}_{client_id}")
        base_path = current_app.config.get("SHAREPOINT_BASE_FOLDER", "weldoc")
        _create_folder(drive_id, base_path, folder_name)
        current_app.logger.info(f"SharePoint: Created client folder '{folder_name}'")
    except Exception as e:
        current_app.logger.error(f"SharePoint: Failed to create client folder: {e}")


def create_project_folders(client_id, client_name, project_title, ist_project_no):
    """Create project folder with Pipelines/ and Materials/ subfolders."""
    try:
        site_id = _get_site_id()
        drive_id = _get_drive_id(site_id)
        base_path = current_app.config.get("SHAREPOINT_BASE_FOLDER", "weldoc")
        client_folder = _sanitize_name(f"{client_name}_{client_id}")
        project_folder = _sanitize_name(f"{project_title}_{ist_project_no}")

        project_path = f"{base_path}/{client_folder}"
        _create_folder(drive_id, project_path, project_folder)

        full_project_path = f"{project_path}/{project_folder}"
        _create_folder(drive_id, full_project_path, "Pipelines")
        _create_folder(drive_id, full_project_path, "Materials")

        current_app.logger.info(f"SharePoint: Created project folders for '{project_folder}'")
    except Exception as e:
        current_app.logger.error(f"SharePoint: Failed to create project folders: {e}")


def create_pipeline_folder(client_id, client_name, project_title, ist_project_no, pipeline_name):
    """Create a pipeline folder inside the project's Pipelines/ folder."""
    try:
        site_id = _get_site_id()
        drive_id = _get_drive_id(site_id)
        base_path = current_app.config.get("SHAREPOINT_BASE_FOLDER", "weldoc")
        client_folder = _sanitize_name(f"{client_name}_{client_id}")
        project_folder = _sanitize_name(f"{project_title}_{ist_project_no}")
        pipeline_folder = _sanitize_name(pipeline_name)

        pipelines_path = f"{base_path}/{client_folder}/{project_folder}/Pipelines"
        _create_folder(drive_id, pipelines_path, pipeline_folder)

        current_app.logger.info(f"SharePoint: Created pipeline folder '{pipeline_folder}'")
    except Exception as e:
        current_app.logger.error(f"SharePoint: Failed to create pipeline folder: {e}")


def upload_waz_document(client_id, client_name, project_title, ist_project_no, heat_no, certificate_no, file_content, content_type="application/pdf"):
    """Upload a WAZ document to the project's Materials/ folder.
    Named as HeatNo_CertificateNo.pdf
    Returns the SharePoint file URL or None on failure.
    """
    try:
        site_id = _get_site_id()
        drive_id = _get_drive_id(site_id)
        base_path = current_app.config.get("SHAREPOINT_BASE_FOLDER", "weldoc")
        client_folder = _sanitize_name(f"{client_name}_{client_id}")
        project_folder = _sanitize_name(f"{project_title}_{ist_project_no}")

        materials_path = f"{base_path}/{client_folder}/{project_folder}/Materials"
        file_name = _sanitize_name(f"{heat_no}_{certificate_no}") + ".pdf"

        result = _upload_file(drive_id, materials_path, file_name, file_content, content_type)
        web_url = result.get("webUrl", "")
        current_app.logger.info(f"SharePoint: Uploaded WAZ document '{file_name}'")
        return web_url
    except Exception as e:
        current_app.logger.error(f"SharePoint: Failed to upload WAZ document: {e}")
        return None
