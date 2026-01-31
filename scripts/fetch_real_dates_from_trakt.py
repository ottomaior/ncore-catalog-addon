import json
import requests
import time
import os
from dotenv import load_dotenv

load_dotenv('../config/config.env')

TRAKT_USERNAME = os.getenv('TRAKT_USERNAME')
LIST_SLUG = os.getenv('TRAKT_SERIES_LIST_SLUG')
CLIENT_ID = os.getenv('TRAKT_CLIENT_ID')
ACCESS_TOKEN = os.getenv('TRAKT_ACCESS_TOKEN')

EPISODE_TRACKER_FILE = 'series_episodes_seen.json'

headers = {
    'Content-Type': 'application/json',
    'trakt-api-version': '2',
    'trakt-api-key': CLIENT_ID,
    'Authorization': f'Bearer {ACCESS_TOKEN}'
}

# Load existing tracker
with open(EPISODE_TRACKER_FILE, 'r', encoding='utf-8') as f:
    tracker = json.load(f)

# Fetch all items from Trakt list
list_url = f'https://api.trakt.tv/users/{TRAKT_USERNAME}/lists/{LIST_SLUG}/items/shows'
response = requests.get(list_url, headers=headers)

if response.status_code == 200:
    trakt_items = response.json()
    
    # Create a map of trakt_id -> listed_at date
    trakt_dates = {}
    for item in trakt_items:
        trakt_id = str(item['show']['ids']['trakt'])
        listed_at = item['listed_at']  # This is when it was added to the list
        trakt_dates[trakt_id] = listed_at
    
    # Update tracker with real dates
    updated_count = 0
    for trakt_id, info in tracker.items():
        if trakt_id in trakt_dates:
            old_date = info.get('added_at', 'N/A')
            info['added_at'] = trakt_dates[trakt_id]
            print(f"✓ Updated {info['show_name']}: {trakt_dates[trakt_id]}")
            updated_count += 1
        else:
            print(f"⚠ {info['show_name']} not found in Trakt list")
    
    # Save updated tracker
    with open(EPISODE_TRACKER_FILE, 'w', encoding='utf-8') as f:
        json.dump(tracker, f, indent=2, ensure_ascii=False)
    
    print(f"\n✓ Updated {updated_count} entries with real Trakt dates")
else:
    print(f"✗ Error fetching list: {response.status_code}")
