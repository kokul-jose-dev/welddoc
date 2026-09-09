"""
SharePoint integration via Microsoft Graph API.
Handles file uploads to project's selected SharePoint folder.
"""

import json
import urllib.request
import urllib.parse
import ssl
import certifi
import time
from flask import current_app

GRAPH_BASE = "https://graph.microsoft.com/v1.0"

_token_cache = {"token": None, "expires_at": 0}
_drive_id_cache = {"drive_id": None, "site_path": None}


def _ssl_context():
    return ssl.create_default_context(cafile=certifi.where())


def _get_app_token():
    """Get an app-only access token using client credentials flow (cached in memory)."""
    now = time.time()
    if _token_cache["token"] and now < (_token_cache["expires_at"] - 60):
        return _token_cache["token"]

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

    token = result["access_token"]
    expires_in = int(result.get("expires_in", 3600))
    _token_cache["token"] = token
    _token_cache["expires_at"] = now + expires_in
    return token


def _sanitize_name(name):
    """Remove characters not allowed in SharePoint folder/file names."""
    invalid = ['~', '#', '%', '&', '*', '{', '}', '\\', ':', '<', '>', '?', '/', '|', '"']
    for ch in invalid:
        name = name.replace(ch, '_')
    return name.strip().strip('.')


def format_waz_filename(item_desc="", dn="", diameter="", thickness="", material_code="", surface="", heat_no="", waz_no=None):
    """Format WAZ filename according to specification:
    Project level: Item description, DN, Outer diameter x Thickness, Material code, Surface, Heat number.pdf
    Pipeline level: {WAZ_No}, Item description, DN, Outer diameter x Thickness, Material code, Surface, Heat number.pdf
    Example:
    Bogen 3D, DN25, Ø33.7x2.0, 1.4304, Ra 0.8, 123456.pdf
    Z001, Bogen 3D, DN25, Ø33.7x2.0, 1.4304, Ra 0.8, 123456.pdf
    """
    parts = []
    if waz_no:
        parts.append(str(waz_no).strip())
    if item_desc:
        parts.append(str(item_desc).strip())
    if dn:
        dn_str = str(dn).strip()
        if not dn_str.upper().startswith("DN") and dn_str.replace(".", "").isdigit():
            dn_str = f"DN{dn_str}"
        parts.append(dn_str)

    dia_str = str(diameter or "").strip().replace("Ø", "").replace("mm", "").strip()
    thk_str = str(thickness or "").strip().replace("mm", "").strip()
    if dia_str and thk_str:
        parts.append(f"Ø{dia_str}x{thk_str}")
    elif dia_str:
        parts.append(f"Ø{dia_str}")
    elif thk_str:
        parts.append(f"{thk_str}mm")

    if material_code:
        parts.append(str(material_code).strip())
    if surface:
        parts.append(str(surface).strip())
    if heat_no:
        parts.append(str(heat_no).strip())

    base_name = ", ".join([p for p in parts if p])
    if not base_name:
        base_name = "WAZ"
    safe_name = _sanitize_name(base_name)
    if not safe_name.lower().endswith(".pdf"):
        safe_name = f"{safe_name}.pdf"
    return safe_name


def upload_waz_to_project_folder(drive_id, folder_id, file_name, file_content, content_type="application/pdf"):
    """Upload a WAZ document to the project's SharePoint folder /WAZ/ subfolder.
    Uses the project's saved driveId and folderId.
    Returns the SharePoint file URL or None on failure.
    """
    try:
        token = _get_app_token()
        if not file_name.lower().endswith(".pdf"):
            safe_file_name = _sanitize_name(file_name) + ".pdf"
        else:
            base = file_name[:-4]
            safe_file_name = _sanitize_name(base) + ".pdf"

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
        upload_url = f"{GRAPH_BASE}/drives/{drive_id}/items/{waz_folder_id}:/{urllib.parse.quote(safe_file_name)}:/content"
        req = urllib.request.Request(upload_url, data=file_content, method="PUT")
        req.add_header("Authorization", f"Bearer {token}")
        req.add_header("Content-Type", content_type)
        with urllib.request.urlopen(req, context=_ssl_context()) as resp:
            result = json.loads(resp.read())

        web_url = result.get("webUrl", "")
        current_app.logger.info(f"SharePoint: Uploaded WAZ document '{safe_file_name}' to WAZ/")
        return web_url
    except Exception as e:
        current_app.logger.error(f"SharePoint: Failed to upload WAZ document: {e}")
        return None


def _get_weldoc_site_drive():
    """Get the drive ID for the weldoc site's default document library (cached in memory)."""
    cfg = current_app.config
    host = cfg.get("SHAREPOINT_HOST", "")
    site_path = cfg.get("SHAREPOINT_SITE_PATH", "/sites/Tutorial")
    key = f"{host}:{site_path}"
    if _drive_id_cache.get("site_path") == key and _drive_id_cache.get("drive_id"):
        return _drive_id_cache["drive_id"]

    token = _get_app_token()
    url = f"{GRAPH_BASE}/sites/{host}:{site_path}:/drive"
    req = urllib.request.Request(url)
    req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, context=_ssl_context()) as resp:
        drive_id = json.loads(resp.read())["id"]
        _drive_id_cache["drive_id"] = drive_id
        _drive_id_cache["site_path"] = key
        return drive_id


def _ensure_sharepoint_folder_path(drive_id, folder_path, token):
    """Ensure a multi-level folder path exists on the drive and return the target folder ID."""
    clean_path = folder_path.strip("/")
    encoded_path = urllib.parse.quote(clean_path)
    get_url = f"{GRAPH_BASE}/drives/{drive_id}/root:/{encoded_path}"
    req = urllib.request.Request(get_url)
    req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, context=_ssl_context()) as resp:
            folder = json.loads(resp.read())
            return folder["id"]
    except urllib.error.HTTPError as e:
        if e.code != 404:
            raise

    # Traverse or create segment by segment starting from root
    segments = [s.strip() for s in clean_path.split("/") if s.strip()]
    root_url = f"{GRAPH_BASE}/drives/{drive_id}/root"
    req_root = urllib.request.Request(root_url)
    req_root.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req_root, context=_ssl_context()) as resp_root:
        current_parent_id = json.loads(resp_root.read())["id"]

    path_accum = ""
    for seg in segments:
        path_accum = f"{path_accum}/{seg}" if path_accum else seg
        enc_accum = urllib.parse.quote(path_accum)
        check_url = f"{GRAPH_BASE}/drives/{drive_id}/root:/{enc_accum}"
        req_check = urllib.request.Request(check_url)
        req_check.add_header("Authorization", f"Bearer {token}")
        try:
            with urllib.request.urlopen(req_check, context=_ssl_context()) as resp_chk:
                current_parent_id = json.loads(resp_chk.read())["id"]
        except urllib.error.HTTPError as he:
            if he.code == 404:
                create_url = f"{GRAPH_BASE}/drives/{drive_id}/items/{current_parent_id}/children"
                body = json.dumps({
                    "name": seg,
                    "folder": {},
                    "@microsoft.graph.conflictBehavior": "fail"
                }).encode("utf-8")
                req_create = urllib.request.Request(create_url, data=body, method="POST")
                req_create.add_header("Authorization", f"Bearer {token}")
                req_create.add_header("Content-Type", "application/json")
                try:
                    with urllib.request.urlopen(req_create, context=_ssl_context()) as resp_cr:
                        current_parent_id = json.loads(resp_cr.read())["id"]
                except urllib.error.HTTPError as err_cr:
                    if err_cr.code == 409:
                        with urllib.request.urlopen(req_check, context=_ssl_context()) as resp_chk2:
                            current_parent_id = json.loads(resp_chk2.read())["id"]
                    else:
                        raise
            else:
                raise

    return current_parent_id


def _get_welder_folder_base():
    cfg = current_app.config
    return cfg.get(
        "SHAREPOINT_WELDER_FOLDER",
        "General/1_QMS ISO 9001_2015/4_Nachweisend/3.2_Personal & Ausbildung/Schweissprüfungen"
    ).strip("/")


def upload_welder_cert(wps_no, welder_name, welder_no, file_content, content_type="application/pdf"):
    """Upload a welder certificate PDF to SharePoint:
    {SHAREPOINT_WELDER_FOLDER}/{wps_no}/WPQ_{name}_{no}_{wps_no}.pdf
    """
    try:
        token = _get_app_token()
        drive_id = _get_weldoc_site_drive()

        safe_wps = _sanitize_name(wps_no or "General").replace(" ", "_")
        safe_name = _sanitize_name(welder_name or "Welder").replace(" ", "_")
        safe_no = _sanitize_name(str(welder_no or "").strip()).replace(" ", "_")

        if safe_no:
            file_name = f"WPQ_{safe_name}_{safe_no}_{safe_wps}.pdf"
        else:
            file_name = f"WPQ_{safe_name}_{safe_wps}.pdf"

        base_folder = _get_welder_folder_base()
        folder_path = f"{base_folder}/{safe_wps}"
        folder_id = _ensure_sharepoint_folder_path(drive_id, folder_path, token)

        if len(file_content) > 4 * 1024 * 1024:
            web_url = _upload_large_file(drive_id, folder_id, file_name, file_content, content_type)
        else:
            upload_url = f"{GRAPH_BASE}/drives/{drive_id}/items/{folder_id}:/{urllib.parse.quote(file_name)}:/content"
            req = urllib.request.Request(upload_url, data=file_content, method="PUT")
            req.add_header("Authorization", f"Bearer {token}")
            req.add_header("Content-Type", content_type)
            with urllib.request.urlopen(req, context=_ssl_context()) as resp:
                result = json.loads(resp.read())
            web_url = result.get("webUrl", "")

        current_app.logger.info(f"SharePoint: Uploaded welder cert '{file_name}' to {folder_path}")
        return web_url
    except Exception as e:
        current_app.logger.error(f"SharePoint: Failed to upload welder cert: {e}")
        return None


def archive_welder_cert(pdf_url, wps_no, welder_name, welder_no, valid_until):
    """Move an expired/archived certificate PDF to:
    {SHAREPOINT_WELDER_FOLDER}/{wps_no}/_Archive/WPQ_{name}_{no}_{wps_no}_{date}.pdf
    """
    if not pdf_url:
        return None
    try:
        import base64
        token = _get_app_token()
        drive_id = _get_weldoc_site_drive()

        safe_wps = _sanitize_name(wps_no or "General").replace(" ", "_")
        safe_name = _sanitize_name(welder_name or "Welder").replace(" ", "_")
        safe_no = _sanitize_name(str(welder_no or "").strip()).replace(" ", "_")
        safe_date = _sanitize_name(str(valid_until or "").strip()).replace(" ", "_").replace("/", "_").replace(":", "_").replace(".", "_")

        if safe_no and safe_date:
            archive_file_name = f"WPQ_{safe_name}_{safe_no}_{safe_wps}_{safe_date}.pdf"
        elif safe_no:
            archive_file_name = f"WPQ_{safe_name}_{safe_no}_{safe_wps}.pdf"
        elif safe_date:
            archive_file_name = f"WPQ_{safe_name}_{safe_wps}_{safe_date}.pdf"
        else:
            archive_file_name = f"WPQ_{safe_name}_{safe_wps}.pdf"

        # Resolve the drive item ID from pdf_url sharing URL
        clean_url = pdf_url.split("?")[0]
        encoded_url = base64.urlsafe_b64encode(clean_url.encode()).decode().rstrip("=")
        share_id = "u!" + encoded_url

        item_url = f"{GRAPH_BASE}/shares/{share_id}/driveItem"
        req = urllib.request.Request(item_url)
        req.add_header("Authorization", f"Bearer {token}")
        with urllib.request.urlopen(req, context=_ssl_context()) as resp:
            item = json.loads(resp.read())
        item_id = item["id"]

        # Ensure archive folder exists
        base_folder = _get_welder_folder_base()
        archive_path = f"{base_folder}/{safe_wps}/_Archive"
        archive_folder_id = _ensure_sharepoint_folder_path(drive_id, archive_path, token)

        # Move and rename file
        move_url = f"{GRAPH_BASE}/drives/{drive_id}/items/{item_id}"
        move_body = json.dumps({
            "parentReference": {"id": archive_folder_id},
            "name": archive_file_name
        }).encode("utf-8")
        req = urllib.request.Request(move_url, data=move_body, method="PATCH")
        req.add_header("Authorization", f"Bearer {token}")
        req.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(req, context=_ssl_context()) as resp:
            result = json.loads(resp.read())

        new_url = result.get("webUrl", "")
        current_app.logger.info(f"SharePoint: Moved cert to '{archive_path}/{archive_file_name}'")
        return new_url
    except Exception as e:
        current_app.logger.error(f"SharePoint: Failed to archive welder cert: {e}")
        return None


def move_welder_cert(pdf_url, new_wps_no, welder_name, welder_no):
    """Move and rename an existing certificate PDF to the new WPS folder on SharePoint:
    {SHAREPOINT_WELDER_FOLDER}/{new_wps_no}/WPQ_{name}_{no}_{new_wps_no}.pdf
    """
    if not pdf_url or not new_wps_no:
        return pdf_url
    try:
        import base64
        token = _get_app_token()
        drive_id = _get_weldoc_site_drive()

        safe_wps = _sanitize_name(new_wps_no or "General").replace(" ", "_")
        safe_name = _sanitize_name(welder_name or "Welder").replace(" ", "_")
        safe_no = _sanitize_name(str(welder_no or "").strip()).replace(" ", "_")

        if safe_no:
            new_file_name = f"WPQ_{safe_name}_{safe_no}_{safe_wps}.pdf"
        else:
            new_file_name = f"WPQ_{safe_name}_{safe_wps}.pdf"

        # Resolve the drive item ID from pdf_url sharing URL
        clean_url = pdf_url.split("?")[0]
        encoded_url = base64.urlsafe_b64encode(clean_url.encode()).decode().rstrip("=")
        share_id = "u!" + encoded_url

        item_url = f"{GRAPH_BASE}/shares/{share_id}/driveItem"
        req = urllib.request.Request(item_url)
        req.add_header("Authorization", f"Bearer {token}")
        with urllib.request.urlopen(req, context=_ssl_context()) as resp:
            item = json.loads(resp.read())
        item_id = item["id"]

        # Ensure target process folder exists
        base_folder = _get_welder_folder_base()
        folder_path = f"{base_folder}/{safe_wps}"
        target_folder_id = _ensure_sharepoint_folder_path(drive_id, folder_path, token)

        # Move and rename file
        move_url = f"{GRAPH_BASE}/drives/{drive_id}/items/{item_id}"
        move_body = json.dumps({
            "parentReference": {"id": target_folder_id},
            "name": new_file_name
        }).encode("utf-8")
        req = urllib.request.Request(move_url, data=move_body, method="PATCH")
        req.add_header("Authorization", f"Bearer {token}")
        req.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(req, context=_ssl_context()) as resp:
            result = json.loads(resp.read())

        new_url = result.get("webUrl", "")
        current_app.logger.info(f"SharePoint: Moved and renamed cert to '{folder_path}/{new_file_name}'")
        return new_url or pdf_url
    except Exception as e:
        current_app.logger.error(f"SharePoint: Failed to move welder cert: {e}")
        return pdf_url


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
    """Upload a file to project_folder/Rohrleitungen/{pipeline_no}/04 Materialzertifikat 3.1/{file_name}.
    Creates the folder structure if needed. Returns the SharePoint file URL or None.
    """
    return upload_to_pipeline_subfolder(drive_id, folder_id, pipeline_no, "04 Materialzertifikat 3.1", file_name, file_content, content_type)


def upload_to_pipeline_subfolder(drive_id, folder_id, pipeline_no, subfolder, file_name, file_content, content_type):
    """Upload a file to project_folder/Rohrleitungen/{pipeline_no}/{subfolder}/{file_name}."""
    try:
        safe_pipeline = _sanitize_name(pipeline_no)
        safe_sub = _sanitize_name(subfolder)
        safe_file = _sanitize_name(file_name)
        upload_path = f"Rohrleitungen/{safe_pipeline}/{safe_sub}/{safe_file}"

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

        current_app.logger.info(f"SharePoint: Uploaded '{safe_file}' to Rohrleitungen/{safe_pipeline}/{safe_sub}/")
        return web_url
    except Exception as e:
        current_app.logger.error(f"SharePoint: Failed to upload to Rohrleitungen/{safe_pipeline}/{subfolder}: {e}")
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


def delete_pipeline_subfolder_file(drive_id, folder_id, pipeline_no, subfolder, file_name):
    """Delete a file from project_folder/Rohrleitungen/{pipeline_no}/{subfolder}/{file_name}."""
    if not drive_id or not folder_id or not file_name:
        return False
    try:
        safe_pipeline = _sanitize_name(pipeline_no)
        safe_sub = _sanitize_name(subfolder)
        safe_file = _sanitize_name(file_name)
        relative_path = f"Rohrleitungen/{safe_pipeline}/{safe_sub}/{safe_file}"
        token = _get_app_token()
        delete_url = f"{GRAPH_BASE}/drives/{drive_id}/items/{folder_id}:/{urllib.parse.quote(relative_path)}"
        req = urllib.request.Request(delete_url, method="DELETE")
        req.add_header("Authorization", f"Bearer {token}")
        with urllib.request.urlopen(req, context=_ssl_context()) as resp:
            pass
        current_app.logger.info(f"SharePoint: Deleted '{safe_file}' from Rohrleitungen/{safe_pipeline}/{safe_sub}/")
        return True
    except urllib.error.HTTPError as e:
        if e.code == 404:
            current_app.logger.warning(f"SharePoint: File '{file_name}' not found for deletion (404).")
            return True
        current_app.logger.error(f"SharePoint: Failed to delete '{file_name}': {e}")
        return False
    except Exception as e:
        current_app.logger.error(f"SharePoint: Failed to delete '{file_name}': {e}")
        return False


def delete_pipeline_waz_file(drive_id, folder_id, pipeline_no, file_name):
    """Delete a file from project_folder/Rohrleitungen/{pipeline_no}/04 Materialzertifikat 3.1/{file_name}."""
    return delete_pipeline_subfolder_file(drive_id, folder_id, pipeline_no, "04 Materialzertifikat 3.1", file_name)


def delete_sharepoint_file_by_url(url):
    """Delete a SharePoint file given its web URL."""
    if not url:
        return False
    try:
        import base64
        token = _get_app_token()
        encoded_url = base64.urlsafe_b64encode(url.encode()).decode().rstrip("=")
        share_id = "u!" + encoded_url
        item_url = f"{GRAPH_BASE}/shares/{share_id}/driveItem"
        req = urllib.request.Request(item_url)
        req.add_header("Authorization", f"Bearer {token}")
        with urllib.request.urlopen(req, context=_ssl_context()) as resp:
            data = json.loads(resp.read())
        drive_id = data.get("parentReference", {}).get("driveId")
        item_id = data.get("id")
        if drive_id and item_id:
            del_url = f"{GRAPH_BASE}/drives/{drive_id}/items/{item_id}"
            del_req = urllib.request.Request(del_url, method="DELETE")
            del_req.add_header("Authorization", f"Bearer {token}")
            with urllib.request.urlopen(del_req, context=_ssl_context()) as resp:
                pass
            current_app.logger.info(f"SharePoint: Deleted file by URL {url}")
            return True
        return False
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return True
        current_app.logger.error(f"SharePoint: Failed to delete file by url: {e}")
        return False
    except Exception as e:
        current_app.logger.error(f"SharePoint: Failed to delete file by url: {e}")
        return False


def list_pipeline_subfolder_files(drive_id, folder_id, pipeline_no, subfolder="04 Materialzertifikat 3.1"):
    """List all files in project_folder/Rohrleitungen/{pipeline_no}/{subfolder}."""
    if not drive_id or not folder_id:
        return []
    try:
        safe_pipeline = _sanitize_name(pipeline_no)
        safe_sub = _sanitize_name(subfolder)
        subfolder_path = f"Rohrleitungen/{safe_pipeline}/{safe_sub}"
        token = _get_app_token()
        list_url = f"{GRAPH_BASE}/drives/{drive_id}/items/{folder_id}:/{urllib.parse.quote(subfolder_path)}:/children"
        req = urllib.request.Request(list_url)
        req.add_header("Authorization", f"Bearer {token}")
        with urllib.request.urlopen(req, context=_ssl_context()) as resp:
            data = json.loads(resp.read())
        return data.get("value", [])
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return []
        current_app.logger.error(f"SharePoint: Failed to list files in subfolder: {e}")
        return []
    except Exception as e:
        current_app.logger.error(f"SharePoint: Failed to list files in subfolder: {e}")
        return []


def delete_sharepoint_drive_item(drive_id, item_id):
    """Delete an item directly by drive_id and item_id."""
    if not drive_id or not item_id:
        return False
    try:
        token = _get_app_token()
        del_url = f"{GRAPH_BASE}/drives/{drive_id}/items/{item_id}"
        req = urllib.request.Request(del_url, method="DELETE")
        req.add_header("Authorization", f"Bearer {token}")
        with urllib.request.urlopen(req, context=_ssl_context()) as resp:
            pass
        current_app.logger.info(f"SharePoint: Deleted drive item {item_id}")
        return True
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return True
        current_app.logger.error(f"SharePoint: Failed to delete item {item_id}: {e}")
        return False
    except Exception as e:
        current_app.logger.error(f"SharePoint: Failed to delete item {item_id}: {e}")
        return False


def clean_pipeline_waz_folder(drive_id, folder_id, pipeline_no, keep_filenames=None):
    """Delete all files in the pipeline's 04 Materialzertifikat 3.1 folder except those in keep_filenames.
    If keep_filenames is None or empty, deletes all files in the folder."""
    if keep_filenames is None:
        keep_filenames = set()
    else:
        keep_filenames = {_sanitize_name(f).strip().lower() for f in keep_filenames}

    files = list_pipeline_subfolder_files(drive_id, folder_id, pipeline_no, "04 Materialzertifikat 3.1")
    deleted_count = 0
    for f in files:
        fname = f.get("name", "").strip()
        safe_fname = _sanitize_name(fname).strip().lower()
        item_id = f.get("id")
        if safe_fname not in keep_filenames and item_id:
            if delete_sharepoint_drive_item(drive_id, item_id):
                deleted_count += 1
    current_app.logger.info(f"SharePoint: Cleaned {deleted_count} obsolete files from pipeline {pipeline_no} WAZ folder.")
    return deleted_count
