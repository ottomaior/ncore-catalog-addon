import feedparser
import requests
import re
import time
import json
import os
from pathlib import Path
from dotenv import load_dotenv
import unicodedata
from datetime import datetime

# Load config from project root
_script_dir = Path(__file__).parent.resolve()
_config_file = _script_dir.parent / 'config' / 'config.env'
load_dotenv(_config_file)


# Configuration from environment
TRAKT_USERNAME = os.getenv('TRAKT_USERNAME')
LIST_SLUG = os.getenv('TRAKT_SERIES_LIST_SLUG')
CLIENT_ID = os.getenv('TRAKT_CLIENT_ID')
ACCESS_TOKEN = os.getenv('TRAKT_ACCESS_TOKEN')
TRAKT_CLIENT_SECRET = os.getenv('TRAKT_CLIENT_SECRET')
TRAKT_REFRESH_TOKEN = os.getenv('TRAKT_REFRESH_TOKEN')


# RSS Feeds for series
# S0%E0% = single episodes (S01E05); S0% = also full season packs (S01)
RSS_FEEDS = [
    'http://finderss.it.cx/?&s=S0%25E0%25.720p&cat=Sorozat%20(HUN%20HD),',
    'http://finderss.it.cx/?&s=S0%25E0%25.1080p&cat=Sorozat%20(HUN%20HD),',
    # Season packs (whole season uploaded as one release, e.g. Show.S01.1080p...)
    'http://finderss.it.cx/?&s=S0%25.720p&cat=Sorozat%20(HUN%20HD),',
    'http://finderss.it.cx/?&s=S0%25.1080p&cat=Sorozat%20(HUN%20HD),',
]


# Episode tracking file
EPISODE_TRACKER_FILE = _script_dir / 'series_episodes_seen.json'


headers = {
    'Content-Type': 'application/json',
    'trakt-api-version': '2',
    'trakt-api-key': CLIENT_ID,
    'Authorization': f'Bearer {ACCESS_TOKEN}'
}


def _refresh_trakt_and_reload():
    """On 401: refresh tokens, update config.env, reload env. Returns True if new token is set."""
    from trakt_auth import refresh_trakt_tokens, update_config_tokens
    client_secret = os.getenv('TRAKT_CLIENT_SECRET')
    refresh_token = os.getenv('TRAKT_REFRESH_TOKEN')
    if not client_secret or not refresh_token:
        return False
    pair = refresh_trakt_tokens(CLIENT_ID, client_secret, refresh_token)
    if not pair:
        return False
    access_token, new_refresh_token = pair
    if update_config_tokens(_config_file, access_token, new_refresh_token):
        load_dotenv(_config_file)
        os.environ['TRAKT_ACCESS_TOKEN'] = access_token
        os.environ['TRAKT_REFRESH_TOKEN'] = new_refresh_token
        headers['Authorization'] = f'Bearer {access_token}'
        print(f"    ✓ Trakt token refreshed and config updated.")
        return True
    return False


def normalize_unicode(text):
    """Normalize Unicode characters to ASCII equivalents"""
    nfd = unicodedata.normalize('NFD', text)
    ascii_text = ''.join(char for char in nfd if unicodedata.category(char) != 'Mn')
    return ascii_text


def load_episode_tracker():
    """Load previously seen episodes"""
    if os.path.exists(EPISODE_TRACKER_FILE):
        with open(EPISODE_TRACKER_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    return {}


def save_episode_tracker(tracker):
    """Save seen episodes to file"""
    with open(EPISODE_TRACKER_FILE, 'w', encoding='utf-8') as f:
        json.dump(tracker, f, indent=2, ensure_ascii=False)


def extract_episode_info(title):
    """Extract season and episode from title (e.g., S02E04 or S01 for full season)"""
    # Try to match S##E## pattern first
    match = re.search(r's(\d{1,2})e(\d{1,2})', title, re.IGNORECASE)
    if match:
        season = int(match.group(1))
        episode = int(match.group(2))
        return season, episode, False  # Not a season pack
    
    # Try to match S## only (full season pack) - treat as E01
    season_match = re.search(r's(\d{1,2})(?![0-9])', title, re.IGNORECASE)
    if season_match:
        season = int(season_match.group(1))
        episode = 1  # Assume first episode for season pack
        return season, episode, True  # Is a season pack
    
    return None, None, False


def extract_year_from_title(title):
    """Extract year from title if present"""
    year_match = re.search(r'\.(\d{4})\.', title)
    if year_match:
        return int(year_match.group(1))
    return None


def is_likely_series(title):
    """Filter out sports from series - Accept S##E## or S## pattern"""
    title_lower = title.lower()
    
    # Accept S##E## or S## (season pack)
    if not re.search(r's\d{1,2}(?:e\d{1,2})?', title_lower):
        return False
    
    exclude_patterns = [
        'futball', 'football', 'soccer', 
        'kezilabda', 'kézilabda',
        'labdarugas', 'labdarúgás',
        'kosarlabda', 'kosárlabda'
    ]
    
    for pattern in exclude_patterns:
        if pattern in title_lower:
            return False
    
    return True


def search_series_on_trakt(clean_title, year_hint=None):
    """Search for series on Trakt with exact match priority and year filtering"""
    
    # Create variations including normalized versions
    variations = [
        clean_title,
        normalize_unicode(clean_title),
    ]
    
    # Add common variations
    if ' and ' in clean_title.lower():
        variations.append(clean_title.replace(' and ', ' & '))
        variations.append(clean_title.replace(' And ', ' & '))
    if ' & ' in clean_title:
        variations.append(clean_title.replace(' & ', ' and '))
    
    # For Hungarian titles, try first word only as fallback
    words = clean_title.split()
    if len(words) >= 2:
        first_word = words[0]
        if len(first_word) > 5:
            variations.append(first_word)
            variations.append(normalize_unicode(first_word))
    
    # Remove duplicates while preserving order
    variations = list(dict.fromkeys(variations))
    
    for variation in variations:
        search_url = f'https://api.trakt.tv/search/show?query={variation}'
        
        if year_hint:
            search_url += f'&years={year_hint}'
        
        try:
            time.sleep(0.5)
            search_response = requests.get(search_url, headers=headers)
            if search_response.status_code == 401 and _refresh_trakt_and_reload():
                search_response = requests.get(search_url, headers=headers)
            if search_response.status_code == 200 and search_response.json():
                results = search_response.json()
                
                if not results:
                    continue
                
                # Debug: Show top 5 results
                print(f"    Searching: '{variation}'" + (f" (year: {year_hint})" if year_hint else ""))
                for i, res in enumerate(results[:5]):
                    show = res['show']
                    score = res.get('score', 0)
                    year = show.get('year', 'N/A')
                    print(f"      {i+1}. {show['title']} ({year}) - Score: {score}")
                
                variation_clean = variation.lower().strip()
                variation_normalized = normalize_unicode(variation_clean)
                
                # Strategy 1: Exact match with Unicode normalization
                for result in results:
                    show = result['show']
                    show_title = show['title']
                    show_title_clean = show_title.lower().strip()
                    show_title_normalized = normalize_unicode(show_title_clean)
                    show_year = show.get('year')
                    
                    if (show_title_clean == variation_clean or 
                        show_title_normalized == variation_normalized):
                        
                        if year_hint and show_year == year_hint:
                            print(f"    ✓ EXACT MATCH (with year): {show_title} ({show_year})")
                            return show, result, results
                        elif not year_hint and show_year and show_year >= 2023:
                            print(f"    ✓ EXACT MATCH (recent): {show_title} ({show_year})")
                            return show, result, results
                        elif results.index(result) == 0:
                            print(f"    ✓ EXACT MATCH: {show_title} ({show_year})")
                            return show, result, results
                
                # Strategy 2: Normalized match (removing punctuation, articles, accents)
                for result in results:
                    show = result['show']
                    show_title = show['title']
                    show_title_clean = show_title.lower().strip()
                    
                    show_normalized = normalize_unicode(show_title_clean)
                    show_normalized = re.sub(r'[^\w\s]', '', show_normalized)
                    show_normalized = re.sub(r'\b(the|a|an)\b', '', show_normalized).strip()
                    show_normalized = re.sub(r'\s+', ' ', show_normalized)
                    
                    var_normalized = normalize_unicode(variation_clean)
                    var_normalized = re.sub(r'[^\w\s]', '', var_normalized)
                    var_normalized = re.sub(r'\b(the|a|an)\b', '', var_normalized).strip()
                    var_normalized = re.sub(r'\s+', ' ', var_normalized)
                    
                    if show_normalized == var_normalized:
                        print(f"    ✓ NORMALIZED MATCH: {show_title} ({show.get('year', 'N/A')})")
                        return show, result, results
                
                # Strategy 3: For short/single word searches, accept top result if it's recent
                word_count = len(clean_title.split())
                if word_count == 1 and variation == words[0]:
                    best_match = results[0]
                    show = best_match['show']
                    show_year = show.get('year')
                    
                    if show_year and show_year >= 2023:
                        print(f"    ✓ ACCEPTED (first word match, recent): {show['title']} ({show_year})")
                        return show, best_match, results
                    else:
                        print(f"    ⚠ SKIPPED: {show['title']} ({show_year}) - using first word only")
                        continue
                
                # Strategy 4: For 1-2 word titles, be strict
                if word_count <= 2 and variation == clean_title:
                    best_match = results[0]
                    show = best_match['show']
                    show_title_clean = show['title'].lower()
                    show_title_normalized = normalize_unicode(show_title_clean)
                    show_year = show.get('year')
                    
                    if word_count == 1:
                        if (show_title_normalized == variation_normalized or
                            show_title_normalized.startswith(variation_normalized + ' ') or
                            show_title_normalized.startswith(variation_normalized + ':')):
                            
                            if len(variation_clean) <= 8:
                                if show_year and show_year >= 2023:
                                    print(f"    ✓ ACCEPTED (recent): {show['title']} ({show_year})")
                                    return show, best_match, results
                                else:
                                    print(f"    ⚠ SKIPPED: {show['title']} ({show_year}) - too old")
                                    continue
                            else:
                                print(f"    ✓ ACCEPTED: {show['title']} ({show_year})")
                                return show, best_match, results
                        else:
                            print(f"    ✗ REJECTED: '{show['title']}' doesn't match '{variation}'")
                            continue
                
                # Strategy 5: Multi-word (3+) - use first result if high score
                if word_count >= 3 and variation == clean_title:
                    best_match = results[0]
                    show = best_match['show']
                    score = best_match.get('score', 0)
                    
                    if score > 100:
                        print(f"    ✓ ACCEPTED (high score): {show['title']}")
                        return show, best_match, results
                
        except Exception as e:
            print(f"    Error searching '{variation}': {e}")
            continue
    
    print(f"    ✗ No acceptable match found for '{clean_title}'")
    return None, None, None


def get_list_items():
    """Get all items currently in the list"""
    list_url = f'https://api.trakt.tv/users/{TRAKT_USERNAME}/lists/{LIST_SLUG}/items/shows'
    
    try:
        time.sleep(0.5)
        response = requests.get(list_url, headers=headers)
        if response.status_code == 401 and _refresh_trakt_and_reload():
            response = requests.get(list_url, headers=headers)
        if response.status_code == 200:
            items = response.json()
            return {item['show']['ids']['trakt']: item for item in items}
        elif response.status_code == 404:
            print(f"Note: List '{LIST_SLUG}' not found or empty")
            return {}
        else:
            print(f"Warning: Error fetching list items: {response.status_code}")
            return {}
    except Exception as e:
        print(f"Warning: {e}")
        return {}


def remove_from_list(trakt_ids):
    """Remove shows from list"""
    remove_url = f'https://api.trakt.tv/users/{TRAKT_USERNAME}/lists/{LIST_SLUG}/items/remove'
    payload = {
        'shows': [{'ids': {'trakt': tid}} for tid in trakt_ids]
    }
    
    try:
        response = requests.post(remove_url, json=payload, headers=headers)
        if response.status_code == 401 and _refresh_trakt_and_reload():
            response = requests.post(remove_url, json=payload, headers=headers)
        if response.status_code == 200:
            result = response.json()
            deleted = result['deleted']['shows']
            print(f"  Removed {deleted} shows for reordering")
            return True
        else:
            print(f"  Error removing: {response.status_code}")
            return False
    except Exception as e:
        print(f"  Error: {e}")
        return False


# Load episode tracker
episode_tracker = load_episode_tracker()


print("=" * 60)
print("SERIES RSS TO TRAKT SYNC")
print("=" * 60)
print(f"\nConfiguration loaded:")
print(f"  Username: {TRAKT_USERNAME}")
print(f"  List: {LIST_SLUG}")
print(f"  Client ID: {CLIENT_ID[:20]}...")
print(f"  Token: {ACCESS_TOKEN[:20]}...")
print(f"\nFetching series RSS feeds...\n")


all_entries = []


for rss_url in RSS_FEEDS:
    print(f"Fetching: {rss_url}")
    feed = feedparser.parse(rss_url)
    
    filtered_count = 0
    for entry in feed.entries:
        if is_likely_series(entry.title):
            all_entries.append(entry)
        else:
            filtered_count += 1
    
    series_count = len([e for e in feed.entries if is_likely_series(e.title)])
    print(f"  Found {series_count} series items ({filtered_count} filtered out)")


print(f"\nTotal series items: {len(all_entries)}\n")


# Get existing list items
print("Fetching current list items...")
existing_items = get_list_items()
print(f"Found {len(existing_items)} shows already in list\n")


shows_to_add = []
shows_to_reorder = []
new_episodes_list = []


for entry in all_entries:
    title = entry.title
    print(f"Processing: {title}")
    
    # Extract episode info (now returns season, episode, is_season_pack)
    season, episode, is_season_pack = extract_episode_info(title)
    
    if not season or not episode:
        print(f"  ⊙ Skipped (no episode info)")
        continue
    
    # Extract year hint
    year_hint = extract_year_from_title(title)
    
    # Extract series name (split before S## pattern)
    clean_title = re.split(r's\d{1,2}(?:e\d{1,2})?', title, flags=re.IGNORECASE)[0]
    clean_title = clean_title.replace('.', ' ').strip()
    clean_title = ' '.join(clean_title.split())
    
    # Remove year from clean_title if it exists (e.g., "Doc 2025" -> "Doc")
    if year_hint:
        clean_title = re.sub(rf'\b{year_hint}\b\s*$', '', clean_title).strip()
    
    print(f"  Searching for: {clean_title}" + (f" (year: {year_hint})" if year_hint else ""))
    if is_season_pack:
        print(f"  Season Pack: S{season:02d} (treating as S{season:02d}E01)")
    else:
        print(f"  Episode: S{season:02d}E{episode:02d}")
    
    # Search for series
    show, result, all_results = search_series_on_trakt(clean_title, year_hint)
    
    if show:
        trakt_id = show['ids']['trakt']
        show_name = show['title']
        print(f"  ✓ Matched: {show_name} [Trakt ID: {trakt_id}]")
        
        tracker_key = str(trakt_id)
        episode_num = season * 100 + episode
        last_seen = episode_tracker.get(tracker_key, {}).get('last_episode', 0)
        
        if episode_num > last_seen:
            print(f"  → NEW episode! (last: S{last_seen // 100:02d}E{last_seen % 100:02d})")
            
            episode_tracker[tracker_key] = {
                'show_name': show_name,
                'last_episode': episode_num,
                'latest_season': season,
                'latest_episode': episode,
                'imdb_id': show['ids'].get('imdb', ''),
                'added_at': datetime.now().isoformat()
            }
            
            new_episodes_list.append({
                'show': show_name,
                'season': season,
                'episode': episode,
                'is_season_pack': is_season_pack
            })
            
            if trakt_id in existing_items:
                shows_to_reorder.append(trakt_id)
            
            shows_to_add.append({'ids': {'trakt': trakt_id}})
        else:
            print(f"  ⊙ Already seen (last: S{last_seen // 100:02d}E{last_seen % 100:02d})")
            
            if trakt_id not in existing_items:
                print(f"  → Adding to list (first time)")
                shows_to_add.append({'ids': {'trakt': trakt_id}})
            
            # Update tracker with episode info even for existing episodes
            if tracker_key not in episode_tracker or episode_num > episode_tracker.get(tracker_key, {}).get('last_episode', 0):
                episode_tracker[tracker_key] = {
                    'show_name': show_name,
                    'last_episode': episode_num,
                    'latest_season': season,
                    'latest_episode': episode,
                    'imdb_id': show['ids'].get('imdb', ''),
                    'added_at': datetime.now().isoformat()  # ✅ Add this line
                }
    else:
        print(f"  ✗ Not found on Trakt")


# Save updated episode tracker
print(f"\n{'=' * 60}")
print(f"DEBUG: Episode Tracker Before Save")
print(f"{'=' * 60}")
print(f"Tracker has {len(episode_tracker)} entries:")
for key, value in episode_tracker.items():
    print(f"  - Trakt ID {key}: {value['show_name']} - S{value['last_episode'] // 100:02d}E{value['last_episode'] % 100:02d}")


save_episode_tracker(episode_tracker)
print(f"\n✓ Episode tracker saved to: {EPISODE_TRACKER_FILE}")


# Verify it was saved
if os.path.exists(EPISODE_TRACKER_FILE):
    with open(EPISODE_TRACKER_FILE, 'r', encoding='utf-8') as f:
        saved_data = json.load(f)
    print(f"✓ Verification: File contains {len(saved_data)} entries")
else:
    print(f"✗ ERROR: File was NOT created!")


print(f"{'=' * 60}\n")


# Remove shows that need reordering
if shows_to_reorder:
    print(f"\nReordering {len(shows_to_reorder)} shows (moving to top)...")
    remove_from_list(shows_to_reorder)
    time.sleep(1)


# Add shows
if shows_to_add:
    print(f"\n{'=' * 60}")
    print(f"Adding {len(shows_to_add)} shows to Trakt list...")
    print(f"{'=' * 60}")
    
    add_url = f'https://api.trakt.tv/users/{TRAKT_USERNAME}/lists/{LIST_SLUG}/items'
    payload = {'shows': shows_to_add}
    
    try:
        response = requests.post(add_url, json=payload, headers=headers)
        if response.status_code == 401 and _refresh_trakt_and_reload():
            response = requests.post(add_url, json=payload, headers=headers)
        if response.status_code == 201:
            result = response.json()
            added = result['added']['shows']
            existing = result['existing']['shows']
            print(f"\n✓ Successfully added {added} new shows")
            if existing > 0:
                print(f"  ({existing} were already in the list)")
            
            if new_episodes_list:
                print(f"\n{'=' * 60}")
                print(f"NEW EPISODES:")
                print(f"{'=' * 60}")
                for ep in new_episodes_list:
                    if ep.get('is_season_pack'):
                        print(f"  📺 {ep['show']} - Season {ep['season']} (Full Season)")
                    else:
                        print(f"  📺 {ep['show']} - S{ep['season']:02d}E{ep['episode']:02d}")
        else:
            print(f"\n✗ Error adding to list: {response.status_code}")
            print(response.text)
    except Exception as e:
        print(f"\n✗ Error: {e}")
else:
    print(f"\n{'=' * 60}")
    print("No new shows to add")
    print(f"{'=' * 60}")


print(f"\n{'=' * 60}")
print("SYNC COMPLETE!")
print(f"{'=' * 60}\n")
