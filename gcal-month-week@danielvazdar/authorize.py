"""Connect the desklet to your Google account. Run once, in a terminal.

Usage:  python3 authorize.py ~/Downloads/client_secret_XXXX.json

The JSON is the "Desktop app" OAuth client you create in Google Cloud (see README).
Your browser opens Google's consent page; after you allow read-only access to
Calendar and Tasks, a login file is written to ~/.config/gcal-desklet/token.json
(permissions 600). Standard library only.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import http.server
import json
import os
import secrets
import sys
import urllib.parse
import webbrowser

import fetch

AUTH_URI = "https://accounts.google.com/o/oauth2/v2/auth"
SCOPES = ("https://www.googleapis.com/auth/calendar.readonly", fetch.TASKS_SCOPE)
LOGIN_WAIT_SECONDS = 300
DONE_PAGE = b"<html><body style='font-family:sans-serif'><h2>Done. You can close this tab.</h2></body></html>"


def load_client(client_file: str) -> tuple[str, str]:
    """Client id and secret from a Google 'Desktop app' client JSON."""
    with open(client_file, encoding="utf-8") as handle:
        content = json.load(handle)
    client = content.get("installed")
    if not client:
        raise SystemExit("This is not a 'Desktop app' OAuth client file (no 'installed' section).")
    return client["client_id"], client["client_secret"]


def pkce_pair() -> tuple[str, str]:
    """A random code verifier and its S256 challenge (RFC 7636)."""
    verifier = secrets.token_urlsafe(64)
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return verifier, challenge


def consent_url(client_id: str, redirect_uri: str, state: str, challenge: str) -> str:
    return AUTH_URI + "?" + urllib.parse.urlencode({
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": " ".join(SCOPES),
        "access_type": "offline",
        "prompt": "consent",
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
    })


def wait_for_redirect(server: http.server.HTTPServer) -> dict[str, str]:
    """Serve requests on the loopback address until Google redirects back with a code or an error."""
    received: dict[str, str] = {}
    timed_out: list[bool] = []

    class RedirectHandler(http.server.BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            received.update({key: values[0] for key, values in query.items()})
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(DONE_PAGE)

        def log_message(self, *args: object) -> None:
            pass

    server.RequestHandlerClass = RedirectHandler
    server.timeout = LOGIN_WAIT_SECONDS
    server.handle_timeout = lambda: timed_out.append(True)  # type: ignore[method-assign]
    while "code" not in received and "error" not in received:
        server.handle_request()  # other requests (e.g. the browser's favicon) just loop again
        if timed_out:
            raise SystemExit("Timed out waiting for the Google login.")
    return received


def write_token(token_path: str, token: dict) -> None:
    os.makedirs(os.path.dirname(token_path), mode=0o700, exist_ok=True)
    temporary_path = f"{token_path}.tmp"
    descriptor = os.open(temporary_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        json.dump(token, handle)
    os.replace(temporary_path, token_path)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("client_file", help="Desktop app OAuth client JSON downloaded from Google Cloud")
    parser.add_argument("--token", default=fetch.TOKEN_PATH_DEFAULT, help="where to save the login file")
    args = parser.parse_args()

    client_id, client_secret = load_client(args.client_file)
    verifier, challenge = pkce_pair()
    state = secrets.token_urlsafe(24)
    server = http.server.HTTPServer(("127.0.0.1", 0), http.server.BaseHTTPRequestHandler)
    redirect_uri = f"http://127.0.0.1:{server.server_port}/"

    url = consent_url(client_id, redirect_uri, state, challenge)
    print("Opening Google's consent page. If no browser opens, visit:\n" + url)
    webbrowser.open(url)
    reply = wait_for_redirect(server)
    server.server_close()
    if reply.get("state") != state:
        raise SystemExit("The reply from Google did not match this login attempt. Try again.")
    if "error" in reply:
        raise SystemExit(f"Google refused: {reply['error']}")

    response = fetch.http_json(fetch.TOKEN_URI, form={
        "client_id": client_id, "client_secret": client_secret, "code": reply["code"],
        "code_verifier": verifier, "grant_type": "authorization_code", "redirect_uri": redirect_uri,
    })
    if "refresh_token" not in response:
        raise SystemExit("Google sent no refresh token. Remove the app's access at "
                         "myaccount.google.com/permissions and run this again.")
    write_token(args.token, {
        "client_id": client_id, "client_secret": client_secret,
        "refresh_token": response["refresh_token"], "token_uri": fetch.TOKEN_URI,
    })
    granted = set(response.get("scope", "").split())
    missing = [scope.rsplit("/", 1)[-1] for scope in SCOPES if scope not in granted]
    print(f"Saved login to {args.token}." + (f" Not granted: {', '.join(missing)}." if missing else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
