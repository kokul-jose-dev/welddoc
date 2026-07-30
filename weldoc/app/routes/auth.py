from flask import Blueprint, redirect, request, session, jsonify, current_app
import uuid
import json
import ssl
import urllib.request
import urllib.parse
import base64
import certifi

auth_bp = Blueprint("auth", __name__)


def _get_redirect_uri():
    scheme = request.headers.get("X-Forwarded-Proto", request.scheme)
    host = request.host
    if "127.0.0.1" in host:
        host = host.replace("127.0.0.1", "localhost")
    return f"{scheme}://{host}/auth/callback"


def _decode_id_token(id_token):
    """Decode JWT payload without verification (Azure already validated it)."""
    parts = id_token.split(".")
    if len(parts) < 2:
        return {}
    payload = parts[1]
    # Add padding
    payload += "=" * (4 - len(payload) % 4)
    decoded = base64.urlsafe_b64decode(payload)
    return json.loads(decoded)


@auth_bp.route("/login")
def login():
    cfg = current_app.config
    session["state"] = str(uuid.uuid4())
    params = urllib.parse.urlencode({
        "client_id": cfg["AZURE_CLIENT_ID"],
        "response_type": "code",
        "redirect_uri": _get_redirect_uri(),
        "scope": "openid profile email User.Read",
        "state": session["state"],
        "response_mode": "query",
    })
    auth_url = f"https://login.microsoftonline.com/{cfg['AZURE_TENANT_ID']}/oauth2/v2.0/authorize?{params}"
    return redirect(auth_url)


@auth_bp.route("/auth/callback", methods=["GET", "POST"])
def auth_callback():
    params = request.form if request.method == "POST" else request.args

    if params.get("state") != session.get("state"):
        return "State mismatch. <a href='/'>Try again</a>", 403

    if "error" in params:
        return f"Login error: {params.get('error_description', params['error'])}", 400

    code = params.get("code")
    if not code:
        return "No authorization code received.", 400

    # Exchange code for tokens using urllib (no msal needed)
    cfg = current_app.config
    token_url = f"https://login.microsoftonline.com/{cfg['AZURE_TENANT_ID']}/oauth2/v2.0/token"
    data = urllib.parse.urlencode({
        "client_id": cfg["AZURE_CLIENT_ID"],
        "client_secret": cfg["AZURE_CLIENT_SECRET"],
        "code": code,
        "redirect_uri": _get_redirect_uri(),
        "grant_type": "authorization_code",
        "scope": "openid profile email User.Read",
    }).encode()

    req = urllib.request.Request(token_url, data=data, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")

    try:
        ssl_context = ssl.create_default_context(cafile=certifi.where())
        with urllib.request.urlopen(req, context=ssl_context) as resp:
            result = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        error_body = e.read().decode()
        return f"Token exchange failed: {error_body}", 400

    # Decode the ID token to get user info
    id_token = result.get("id_token", "")
    claims = _decode_id_token(id_token)
    email = claims.get("preferred_username", claims.get("email", "")).lower()
    name = claims.get("name", "")

    # Restrict to @istinox.ch and @botangelos.com only
    if not (email.endswith("@istinox.ch") or email.endswith("@botangelos.com")):
        session.clear()
        return (
            "<h2>Access Denied</h2>"
            "<p>Only @istinox.ch and @botangelos.com accounts are allowed.</p>"
            "<a href='/'>Back</a>"
        ), 403

    session["user"] = {"email": email, "name": name, "role": "office"}
    return redirect("/home.html")


@auth_bp.route("/auth/me")
def auth_me():
    user = session.get("user")
    if not user:
        return jsonify({"logged_in": False}), 401
    return jsonify({"logged_in": True, **user})


@auth_bp.route("/logout")
def logout():
    session.clear()
    tenant = current_app.config["AZURE_TENANT_ID"]
    scheme = request.headers.get("X-Forwarded-Proto", request.scheme)
    post_logout = f"{scheme}://{request.host}/"
    return redirect(
        f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/logout"
        f"?post_logout_redirect_uri={post_logout}"
    )
