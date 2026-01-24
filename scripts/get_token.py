import requests
import os
from pathlib import Path
from dotenv import load_dotenv

# Load config
script_dir = Path(__file__).parent.resolve()
project_root = script_dir.parent
config_file = project_root / 'config' / 'config.env'
load_dotenv(config_file)

CLIENT_ID = os.getenv('TRAKT_CLIENT_ID')
CLIENT_SECRET = os.getenv('TRAKT_CLIENT_SECRET')

if not CLIENT_ID or not CLIENT_SECRET:
    print("✗ Missing TRAKT_CLIENT_ID or TRAKT_CLIENT_SECRET in config.env")
    print("  Get these from: https://trakt.tv/oauth/applications")
    exit(1)

# Get device code
print("Requesting device code from Trakt...")
response = requests.post('https://api.trakt.tv/oauth/device/code', 
    json={'client_id': CLIENT_ID})

if response.status_code != 200:
    print(f"✗ Error getting device code: {response.status_code}")
    print(response.text)
    exit(1)

device_code = response.json()

print(f"\n{'='*60}")
print(f"AUTHORIZATION REQUIRED")
print(f"{'='*60}")
print(f"\n1. Go to: {device_code['verification_url']}")
print(f"2. Enter code: {device_code['user_code']}")
print(f"\n{'='*60}\n")
input("Press Enter after authorizing...")

# Exchange for access token
print("\nExchanging code for access token...")
token_response = requests.post('https://api.trakt.tv/oauth/device/token',
    json={
        'code': device_code['device_code'],
        'client_id': CLIENT_ID,
        'client_secret': CLIENT_SECRET
    })

if token_response.status_code == 200:
    tokens = token_response.json()
    access_token = tokens['access_token']
    refresh_token = tokens.get('refresh_token', 'N/A')
    
    print(f"\n{'='*60}")
    print(f"✓ SUCCESS! TOKEN GENERATED")
    print(f"{'='*60}\n")
    print(f"Access Token:  {access_token}")
    print(f"Refresh Token: {refresh_token}")
    print(f"\n{'='*60}")
    print(f"Add this to your config/config.env:")
    print(f"{'='*60}\n")
    print(f"TRAKT_ACCESS_TOKEN={access_token}")
    print(f"\n{'='*60}\n")
else:
    print(f"✗ Error getting token: {token_response.status_code}")
    print(token_response.text)
