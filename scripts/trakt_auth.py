"""
Trakt OAuth token refresh and config update.
Use this when access token expires (401): refresh and write new tokens to config.env.
"""
import os
import re
import requests
from pathlib import Path


def refresh_trakt_tokens(client_id, client_secret, refresh_token):
    """
    Exchange refresh_token for new access_token and refresh_token.
    Returns (access_token, refresh_token) or None on failure.
    """
    if not all([client_id, client_secret, refresh_token]):
        return None
    data = {
        'client_id': client_id,
        'client_secret': client_secret,
        'refresh_token': refresh_token,
        'grant_type': 'refresh_token',
        'redirect_uri': 'urn:ietf:wg:oauth:2.0:oob',
    }
    try:
        resp = requests.post('https://api.trakt.tv/oauth/token', json=data, timeout=15)
        if resp.status_code != 200:
            return None
        tokens = resp.json()
        return tokens.get('access_token'), tokens.get('refresh_token')
    except Exception:
        return None


def update_config_tokens(config_path, access_token, refresh_token):
    """
    Update TRAKT_ACCESS_TOKEN and TRAKT_REFRESH_TOKEN in config file.
    Preserves other lines and key order. Adds lines if missing.
    """
    path = Path(config_path)
    if not path.exists():
        return False
    text = path.read_text(encoding='utf-8')
    lines = text.splitlines()
    seen_access, seen_refresh = False, False
    out = []
    for line in lines:
        if re.match(r'^\s*TRAKT_ACCESS_TOKEN\s*=', line):
            out.append(f'TRAKT_ACCESS_TOKEN={access_token}')
            seen_access = True
        elif re.match(r'^\s*TRAKT_REFRESH_TOKEN\s*=', line):
            out.append(f'TRAKT_REFRESH_TOKEN={refresh_token}')
            seen_refresh = True
        else:
            out.append(line)
    if not seen_access:
        out.append(f'TRAKT_ACCESS_TOKEN={access_token}')
    if not seen_refresh:
        out.append(f'TRAKT_REFRESH_TOKEN={refresh_token}')
    path.write_text('\n'.join(out) + '\n', encoding='utf-8')
    return True
