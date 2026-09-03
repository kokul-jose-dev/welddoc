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


def _get_weldoc_site_drive():
    """Get the drive ID for the weldoc site's default document library."""
    cfg = current_app.config
    host = cfg.get("SHAREPOINT_HOST", "")
    site_path = cfg.get("SHAREPOINT_SITE_PATH", "/sites/Tutorial")
    token = _get_app_token()
    url = f"{GRAPH_BASE}/sites/{host}:{site_path}:/drive"
    req = urllib.request.Request(url)
    req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, context=_ssl_context()) as resp:
        return json.loads(resp.read())["id"]


def upload_welder_cert(file_name, file_content, content_type="application/pdf"):
    """Upload a welder certificate PDF to SharePoint /weldoc/welder/ folder."""
    try:
        token = _get_app_token()
        drive_id = _get_weldoc_site_drive()
        safe_name = _sanitize_name(file_name)

        # Upload to /weldoc/welder/{file_name} (auto-creates path)
        upload_path = f"weldoc/welder/{safe_name}"
        upload_url = f"{GRAPH_BASE}/drives/{drive_id}/root:/{urllib.parse.quote(upload_path)}:/content"
        req = urllib.request.Request(upload_url, data=file_content, method="PUT")
        req.add_header("Authorization", f"Bearer {token}")
        req.add_header("Content-Type", content_type)
        with urllib.request.urlopen(req, context=_ssl_context()) as resp:
            result = json.loads(resp.read())

        web_url = result.get("webUrl", "")
        current_app.logger.info(f"SharePoint: Uploaded welder cert '{safe_name}'")
        return web_url
    except Exception as e:
        current_app.logger.error(f"SharePoint: Failed to upload welder cert: {e}")
        return None


def upload_welder_signature(file_name, file_content, content_type="image/png"):
    """Upload a welder signature image to SharePoint /weldoc/welder/Signature/ folder."""
    try:
        token = _get_app_token()
        drive_id = _get_weldoc_site_drive()
        safe_name = _sanitize_name(file_name)

        upload_path = f"weldoc/welder/Signature/{safe_name}"
        upload_url = f"{GRAPH_BASE}/drives/{drive_id}/root:/{urllib.parse.quote(upload_path)}:/content"
        req = urllib.request.Request(upload_url, data=file_content, method="PUT")
        req.add_header("Authorization", f"Bearer {token}")
        req.add_header("Content-Type", content_type)
        with urllib.request.urlopen(req, context=_ssl_context()) as resp:
            result = json.loads(resp.read())

        web_url = result.get("webUrl", "")
        current_app.logger.info(f"SharePoint: Uploaded signature '{safe_name}' to weldoc/welder/Signature/")
        return web_url
    except Exception as e:
        current_app.logger.error(f"SharePoint: Failed to upload welder signature: {e}")
        return None


def delete_sharepoint_file(url):
    """Delete a file from SharePoint given its webUrl using MS Graph API."""
    if not url:
        return False
    try:
        import base64
        token = _get_app_token()
        clean_url = url.split("?")[0]
        encoded_url = base64.urlsafe_b64encode(clean_url.encode()).decode().rstrip("=")
        share_id = "u!" + encoded_url
        item_url = f"{GRAPH_BASE}/shares/{share_id}/driveItem"
        req = urllib.request.Request(item_url, method="DELETE")
        req.add_header("Authorization", f"Bearer {token}")
        with urllib.request.urlopen(req, context=_ssl_context()) as resp:
            pass
        current_app.logger.info(f"SharePoint: Deleted file at {clean_url}")
        return True
    except urllib.error.HTTPError as he:
        if he.code == 404:
            current_app.logger.info(f"SharePoint: File at {url} already deleted or not found (404)")
            return True
        current_app.logger.error(f"SharePoint: Failed to delete file by share URL ({he.code}): {he}")
        return False
    except Exception as e:
        current_app.logger.error(f"SharePoint: Failed to delete file: {e}")
        return False


def delete_welder_signature_file(file_name_or_url):
    """Delete a welder signature file from SharePoint /weldoc/welder/Signature/ folder."""
    if not file_name_or_url:
        return False
    # If it's a full URL, attempt direct share delete first
    if str(file_name_or_url).startswith("http"):
        if delete_sharepoint_file(file_name_or_url):
            return True
        # Extract filename as fallback
        file_name = file_name_or_url.split("?")[0].split("/")[-1]
    else:
        file_name = file_name_or_url

    try:
        token = _get_app_token()
        drive_id = _get_weldoc_site_drive()
        safe_name = _sanitize_name(urllib.parse.unquote(file_name))
        del_path = f"weldoc/welder/Signature/{safe_name}"
        del_url = f"{GRAPH_BASE}/drives/{drive_id}/root:/{urllib.parse.quote(del_path)}"
        req = urllib.request.Request(del_url, method="DELETE")
        req.add_header("Authorization", f"Bearer {token}")
        with urllib.request.urlopen(req, context=_ssl_context()) as resp:
            pass
        current_app.logger.info(f"SharePoint: Deleted signature '{safe_name}' from weldoc/welder/Signature/")
        return True
    except urllib.error.HTTPError as he:
        if he.code == 404:
            return True
        current_app.logger.error(f"SharePoint: Failed to delete signature '{file_name}' ({he.code}): {he}")
        return False
    except Exception as e:
        current_app.logger.error(f"SharePoint: Failed to delete signature '{file_name}': {e}")
        return False


def _upload_large_file(drive_id, folder_id, relative_path, file_content, content_type):
    """Upload files larger than 4MB using Microsoft Graph upload session (chunked)."""
    token = _get_app_token()
    session_url = f"{GRAPH_BASE}/drives/{drive_id}/items/{folder_id}:/{urllib.parse.quote(relative_path)}:/createUploadSession"
    body = json.dumps({
        "item": {
            "@microsoft.graph.conflictBehavior": "replace",
            "name": relative_path.rsplit("/", 1)[-1]
        }
    }).encode("utf-8")
    req = urllib.request.Request(session_url, data=body, method="POST")
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, context=_ssl_context()) as resp:
        session_info = json.loads(resp.read())
    upload_url = session_info["uploadUrl"]

    total_len = len(file_content)
    chunk_size = 10 * 1024 * 1024  # 10MB chunks
    start = 0
    result = None

    while start < total_len:
        end = min(start + chunk_size, total_len)
        chunk = file_content[start:end]
        req = urllib.request.Request(upload_url, data=chunk, method="PUT")
        req.add_header("Content-Length", str(len(chunk)))
        req.add_header("Content-Range", f"bytes {start}-{end - 1}/{total_len}")
        with urllib.request.urlopen(req, context=_ssl_context()) as resp:
            resp_data = resp.read()
            if resp_data:
                result = json.loads(resp_data)
        start = end

    return result.get("webUrl", "") if result else ""


def upload_to_pipeline_waz_folder(drive_id, folder_id, pipeline_no, file_name, file_content, content_type="application/pdf"):
    """Upload a file to project_folder/{pipeline_no}/WAZ/{file_name}.
    Creates the folder structure if needed. Returns the SharePoint file URL or None.
    """
    try:
        safe_pipeline = _sanitize_name(pipeline_no)
        safe_file = _sanitize_name(file_name)
        upload_path = f"{safe_pipeline}/WAZ/{safe_file}"

        if len(file_content) > 4 * 1024 * 1024:
            web_url = _upload_large_file(drive_id, folder_id, upload_path, file_content, content_type)
        else:
            token = _get_app_token()
            upload_url = f"{GRAPH_BASE}/drives/{drive_id}/items/{folder_id}:/{urllib.parse.quote(upload_path)}:/content"
            req = urllib.request.Request(upload_url, data=file_content, method="PUT")
            req.add_header("Authorization", f"Bearer {token}")
            req.add_header("Content-Type", content_type)
            with urllib.request.urlopen(req, context=_ssl_context()) as resp:
                result = json.loads(resp.read())
            web_url = result.get("webUrl", "")

        current_app.logger.info(f"SharePoint: Uploaded '{safe_file}' to {safe_pipeline}/WAZ/")
        return web_url
    except Exception as e:
        current_app.logger.error(f"SharePoint: Failed to upload to pipeline WAZ folder: {e}")
        return None


def upload_to_pipeline_subfolder(drive_id, folder_id, pipeline_no, subfolder, file_name, file_content, content_type):
    """Upload a file to project_folder/{pipeline_no}/{subfolder}/{file_name}."""
    try:
        safe_pipeline = _sanitize_name(pipeline_no)
        safe_sub = _sanitize_name(subfolder)
        safe_file = _sanitize_name(file_name)
        upload_path = f"{safe_pipeline}/{safe_sub}/{safe_file}"

        if len(file_content) > 4 * 1024 * 1024:
            web_url = _upload_large_file(drive_id, folder_id, upload_path, file_content, content_type)
        else:
            token = _get_app_token()
            upload_url = f"{GRAPH_BASE}/drives/{drive_id}/items/{folder_id}:/{urllib.parse.quote(upload_path)}:/content"
            req = urllib.request.Request(upload_url, data=file_content, method="PUT")
            req.add_header("Authorization", f"Bearer {token}")
            req.add_header("Content-Type", content_type)
            with urllib.request.urlopen(req, context=_ssl_context()) as resp:
                result = json.loads(resp.read())
            web_url = result.get("webUrl", "")

        current_app.logger.info(f"SharePoint: Uploaded '{safe_file}' to {safe_pipeline}/{safe_sub}/")
        return web_url
    except Exception as e:
        current_app.logger.error(f"SharePoint: Failed to upload to {safe_pipeline}/{subfolder}: {e}")
        return None


def _download_sharepoint_file_content(url):
    """Download a file from SharePoint given its web URL. Returns bytes or None."""
    if not url:
        return None
    try:
        import base64
        token = _get_app_token()
        encoded_url = base64.urlsafe_b64encode(url.encode()).decode().rstrip("=")
        share_id = "u!" + encoded_url
        download_url = f"{GRAPH_BASE}/shares/{share_id}/driveItem/content"
        req = urllib.request.Request(download_url)
        req.add_header("Authorization", f"Bearer {token}")
        with urllib.request.urlopen(req, context=_ssl_context()) as resp:
            return resp.read()
    except Exception as e:
        current_app.logger.error(f"SharePoint: Failed to download file: {e}")
        return None
