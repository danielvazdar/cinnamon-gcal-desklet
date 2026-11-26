import base64
import hashlib
import json
import os
import stat
import sys
import urllib.parse

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "gcal-month-week@osobno"))
import authorize


def test_pkce_challenge_is_the_s256_of_the_verifier():
    verifier, challenge = authorize.pkce_pair()
    expected = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    assert challenge == expected
    assert 43 <= len(verifier) <= 128


def test_consent_url_asks_for_read_only_calendar_and_tasks_offline():
    url = authorize.consent_url("client-1", "http://127.0.0.1:5000/", "state-1", "challenge-1")
    query = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
    assert query["scope"][0].split() == list(authorize.SCOPES)
    assert all(scope.endswith(".readonly") for scope in authorize.SCOPES)
    assert (query["access_type"][0], query["code_challenge_method"][0]) == ("offline", "S256")
    assert query["redirect_uri"][0] == "http://127.0.0.1:5000/"


def test_web_client_file_is_rejected(tmp_path):
    client_file = tmp_path / "client.json"
    client_file.write_text(json.dumps({"web": {"client_id": "x", "client_secret": "y"}}))
    with pytest.raises(SystemExit, match="Desktop app"):
        authorize.load_client(str(client_file))


def test_desktop_client_file_is_read(tmp_path):
    client_file = tmp_path / "client.json"
    client_file.write_text(json.dumps({"installed": {"client_id": "id-1", "client_secret": "secret-1"}}))
    assert authorize.load_client(str(client_file)) == ("id-1", "secret-1")


def test_login_file_is_private_to_the_user(tmp_path):
    token_path = tmp_path / "config" / "token.json"
    authorize.write_token(str(token_path), {"refresh_token": "r"})
    assert stat.S_IMODE(os.stat(token_path).st_mode) == 0o600
    assert json.loads(token_path.read_text()) == {"refresh_token": "r"}
