import feedparser
import requests
import re
import time
import os
from pathlib import Path
from dotenv import load_dotenv

# Get absolute path to config file
script_dir = Path(__file__).parent.resolve()
project_root = script_dir.parent
config_file = project_root / 'config' / 'config.env'

# Load environment variables (config file optional in CI)
if config_file.exists():
    load_dotenv(config_file)
    print(f"✓ Loaded config from: {config_file}")
else:
    print(f"ℹ Config file not found (using environment variables from GitHub Actions)")


# Get credentials from environment
TRAKT_CLIENT_ID = os.getenv('TRAKT_CLIENT_ID')
TRAKT_ACCESS_TOKEN = os.getenv('TRAKT_ACCESS_TOKEN')
TRAKT_CLIENT_SECRET = os.getenv('TRAKT_CLIENT_SECRET')
TRAKT_REFRESH_TOKEN = os.getenv('TRAKT_REFRESH_TOKEN')
TRAKT_LIST_SLUG = os.getenv('TRAKT_LIST_SLUG')
TRAKT_USERNAME = os.getenv('TRAKT_USERNAME')

# Get RSS feeds – MOVIES ONLY. Prefer explicit movie feeds to avoid using series URLs.
RSS_FEEDS = []
i = 1
while True:
    feed_url = os.getenv(f'RSS_FEED_MOVIES_{i}') or os.getenv(f'RSS_FEED_{i}')
    if feed_url:
        RSS_FEEDS.append(feed_url)
        i += 1
    else:
        break
if not RSS_FEEDS and os.getenv('RSS_URL'):
    RSS_FEEDS = [os.getenv('RSS_URL')]
# Default: Film (HUN HD) feeds only – never use Sorozat/series feeds here
if not RSS_FEEDS:
    RSS_FEEDS = [
        'http://finderss.it.cx/?&s=2025.720p&cat=Film%20(HUN%20HD),',
        'http://finderss.it.cx/?&s=2026.720p&cat=Film%20(HUN%20HD),',
    ]
    print("✓ Using default Film (movie) RSS feeds (set RSS_FEED_MOVIES_1, RSS_FEED_MOVIES_2 to override)")

# Validate all required variables are set
if not TRAKT_CLIENT_ID or not TRAKT_ACCESS_TOKEN or not TRAKT_LIST_SLUG or not TRAKT_USERNAME:
    print("✗ Missing required Trakt credentials")
    exit(1)

print(f"✓ Configuration loaded: {len(RSS_FEEDS)} RSS feed(s)\n")

# Headers for Trakt API (updated when token is refreshed)
def _trakt_headers():
    return {
        'Content-Type': 'application/json',
        'trakt-api-version': '2',
        'trakt-api-key': TRAKT_CLIENT_ID,
        'Authorization': f'Bearer {os.getenv("TRAKT_ACCESS_TOKEN", TRAKT_ACCESS_TOKEN)}'
    }


headers = _trakt_headers()


def _refresh_trakt_and_reload():
    """On 401: refresh tokens, update config.env, reload env. Returns True if new token is set."""
    from trakt_auth import refresh_trakt_tokens, update_config_tokens
    client_id = os.getenv('TRAKT_CLIENT_ID')
    client_secret = os.getenv('TRAKT_CLIENT_SECRET')
    refresh_token = os.getenv('TRAKT_REFRESH_TOKEN')
    if not client_secret or not refresh_token:
        return False
    pair = refresh_trakt_tokens(client_id, client_secret, refresh_token)
    if not pair:
        return False
    access_token, new_refresh_token = pair
    if update_config_tokens(config_file, access_token, new_refresh_token):
        load_dotenv(config_file)
        os.environ['TRAKT_ACCESS_TOKEN'] = access_token
        os.environ['TRAKT_REFRESH_TOKEN'] = new_refresh_token
        global headers
        headers = _trakt_headers()
        print(f"    ✓ Trakt token refreshed and config updated.")
        return True
    return False


def search_movie_on_trakt(clean_title, year):
    """Search for a movie on Trakt, trying multiple variations"""
    
    # Try original title first
    variations = [
        clean_title,
        clean_title.replace(' and ', ' & '),  # Try with &
        clean_title.replace(' & ', ' and '),  # Try with and
    ]
    
    # Remove duplicates while preserving order
    variations = list(dict.fromkeys(variations))
    
    for variation in variations:
        search_url = f'https://api.trakt.tv/search/movie?query={variation}'
        if year:
            search_url += f'&years={year}'
        
        try:
            time.sleep(0.5)  # Rate limiting
            search_response = requests.get(search_url, headers=headers)
            
            # On 401: try to refresh token and retry once
            if search_response.status_code == 401:
                if _refresh_trakt_and_reload():
                    search_response = requests.get(search_url, headers=headers)
                else:
                    print(f"    ✗ Trakt auth failed (401). Add TRAKT_CLIENT_SECRET and TRAKT_REFRESH_TOKEN to config, or run fresh_auth.py.")
                    return None, None, None
            if search_response.status_code == 401:
                return None, None, None
            if search_response.status_code == 403:
                print(f"    ✗ Trakt access denied (403). Check API key and token.")
                return None, None, None
            if search_response.status_code != 200:
                print(f"    ✗ Trakt API error: {search_response.status_code}")
                continue
            
            data = search_response.json()
            if not data:
                continue
            # API can return error object instead of list (e.g. auth failure with 200 in some cases)
            if not isinstance(data, list):
                print(f"    ✗ Unexpected Trakt response (not a list). Check token.")
                continue
            results = data
            
            for result in results:
                movie = result.get('movie')
                if not movie:
                    continue
                movie_year = str(movie['year']) if movie.get('year') else ''
                movie_title_lower = movie['title'].lower()
                variation_lower = variation.lower()
                is_first = results.index(result) == 0
                title_match = (
                    movie_title_lower in variation_lower or
                    variation_lower in movie_title_lower or
                    variation_lower.replace(' ', '') in movie_title_lower.replace(' ', '')
                )
                
                # When year is in title: require year match and title similarity
                if year:
                    if movie_year != year:
                        continue
                    if title_match or is_first:
                        return movie, result, results
                else:
                    # No year in RSS title: accept by title match, prefer first result
                    if title_match or is_first:
                        return movie, result, results
                
        except Exception as e:
            print(f"    Error searching variation '{variation}': {e}")
            continue
    
    return None, None, None


def is_likely_series(title):
    """Skip series (S##E## or S##) – this script is for movies only."""
    if not title:
        return False
    # Match S01E05, S01E125, S02 (season pack), etc. – case insensitive (episode can be 3+ digits)
    return bool(re.search(r'\bS\d{1,2}(?:E\d{1,4})?\b', title, re.IGNORECASE))


# Fetch RSS feeds
print(f"Fetching {len(RSS_FEEDS)} RSS feed(s)...")
all_entries = []

for i, rss_url in enumerate(RSS_FEEDS, 1):
    print(f"  Feed {i}: {rss_url}")
    feed = feedparser.parse(rss_url)
    print(f"  Found {len(feed.entries)} items")
    all_entries.extend(feed.entries)

# Movie sync only: drop any entry that looks like a series (S01E05, S02, etc.)
raw_count = len(all_entries)
all_entries = [e for e in all_entries if not is_likely_series(e.title)]
skipped = raw_count - len(all_entries)
if skipped:
    print(f"  (Skipped {skipped} series – movie sync only)")
print(f"\nTotal movie items to process: {len(all_entries)}\n")


# Process each entry
movies_to_add = []

for entry in all_entries:
    title = entry.title
    print(f"Processing: {title}")
    
    # Extract year if present (looks for pattern like .2025.)
    year_match = re.search(r'\.(\d{4})\.', title)
    year = year_match.group(1) if year_match else None
    
    # Clean title - remove everything after the year
    if year_match:
        clean_title = title[:year_match.start()]
    else:
        clean_title = title
    
    # Replace dots with spaces
    clean_title = clean_title.replace('.', ' ')
    
    # Remove extra spaces
    clean_title = ' '.join(clean_title.split())
    
    print(f"  Searching for: {clean_title} ({year})")
    
    # Search with variations
    movie, result, all_results = search_movie_on_trakt(clean_title, year)
    
    if movie:
        print(f"  ✓ Found: {movie['title']} ({movie['year']}) [Score: {result.get('score', 'N/A')}]")
        movies_to_add.append({
            'ids': {'trakt': movie['ids']['trakt']}
        })
    else:
        print(f"  ✗ No match found" + (f" for year {year}" if year else ""))
        # Show alternatives if available
        if all_results:
            for i, res in enumerate(all_results[:3]):
                m = res['movie']
                print(f"     - Option {i+1}: {m['title']} ({m['year']})")


# Add movies to list
if movies_to_add:
    print(f"\nAdding {len(movies_to_add)} movies to Trakt list...")
    add_url = f'https://api.trakt.tv/users/{TRAKT_USERNAME}/lists/{TRAKT_LIST_SLUG}/items'
    payload = {'movies': movies_to_add}
    
    try:
        response = requests.post(add_url, json=payload, headers=headers)
        if response.status_code == 401 and _refresh_trakt_and_reload():
            response = requests.post(add_url, json=payload, headers=headers)
        if response.status_code == 201:
            result = response.json()
            added = result['added']['movies']
            existing = result['existing']['movies']
            not_found_count = len(result.get('not_found', {}).get('movies', []))
            print(f"✓ Successfully added {added} new movies")
            print(f"  ({existing} were already in the list)")
            if not_found_count > 0:
                print(f"  ({not_found_count} were not found on Trakt)")
        else:
            print(f"✗ Error adding to list: {response.status_code}")
            print(response.text)
    except Exception as e:
        print(f"✗ Error: {e}")
else:
    print("\nNo movies to add")

print("\nDone!")
