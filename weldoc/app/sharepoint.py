"""
SharePoint integration via Microsoft Graph API.
Handles file uploads to project's selected SharePoint folder.
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


def _sanitize_name(name):
    """Remove characters not allowed in SharePoint folder/file names."""
    invalid = ['~', '#', '%', '&', '*', '{', '}', '\\', ':', '<', '>', '?', '/', '|', '"']
    for ch in invalid:
        name = name.replace(ch, '_')
    return name.strip().strip('.')


def upload_waz_to_project_folder(drive_id, folder_id, heat_no, certificate_no, file_content, content_type="application/pdf"):
    """Upload a WAZ document to the project's SharePoint folder /WAZ/ subfolder.
    Uses the project's saved driveId and folderId.
    Returns the SharePoint file URL or None on failure.
    """
    try:
        token = _get_app_token()
        file_name = _sanitize_name(f"{heat_no}_{certificate_no}") + ".pdf"

        # First ensure WAZ subfolder exists
        create_url = f"{GRAPH_BASE}/drives/{drive_id}/items/{folder_id}/children"
        body = json.dumps({
            "name": "WAZ",
            "folder": {},
            "@microsoft.graph.conflictBehavior": "fail"
        }).encode()
        req = urllib.request.Request(create_url, data=body, method="POST")
        req.add_header("Authorization", f"Bearer {token}")
        req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, context=_ssl_context()) as resp:
                waz_folder = json.loads(resp.read())
                waz_folder_id = waz_folder["id"]
        except urllib.error.HTTPError as e:
            if e.code == 409:
                # WAZ folder already exists — get its ID
                list_url = f"{GRAPH_BASE}/drives/{drive_id}/items/{folder_id}/children?" + urllib.parse.urlencode({"$filter": "name eq 'WAZ'"})
                req2 = urllib.request.Request(list_url)
                req2.add_header("Authorization", f"Bearer {token}")
                with urllib.request.urlopen(req2, context=_ssl_context()) as resp2:
                    items = json.loads(resp2.read())
                    waz_folder_id = items["value"][0]["id"]
            else:
                raise

        # Upload file to WAZ folder
        upload_url = f"{GRAPH_BASE}/drives/{drive_id}/items/{waz_folder_id}:/{urllib.parse.quote(file_name)}:/content"
        req = urllib.request.Request(upload_url, data=file_content, method="PUT")
        req.add_header("Authorization", f"Bearer {token}")
        req.add_header("Content-Type", content_type)
        with urllib.request.urlopen(req, context=_ssl_context()) as resp:
            result = json.loads(resp.read())

        web_url = result.get("webUrl", "")
        current_app.logger.info(f"SharePoint: Uploaded WAZ document '{file_name}'")
        return web_url
    except Exception as e:
        current_app.logger.error(f"SharePoint: Failed to upload WAZ document: {e}")
        return None
