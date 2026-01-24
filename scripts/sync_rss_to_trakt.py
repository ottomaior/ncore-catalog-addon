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

# Load environment variables
if config_file.exists():
    load_dotenv(config_file)
else:
    print(f"✗ Config file not found: {config_file}")
    exit(1)

# Get credentials from environment
TRAKT_CLIENT_ID = os.getenv('TRAKT_CLIENT_ID')
TRAKT_ACCESS_TOKEN = os.getenv('TRAKT_ACCESS_TOKEN')
TRAKT_LIST_SLUG = os.getenv('TRAKT_LIST_SLUG')
TRAKT_USERNAME = os.getenv('TRAKT_USERNAME')

# Get RSS feeds (support multiple feeds with _1, _2, etc.)
RSS_FEEDS = []
i = 1
while True:
    feed_url = os.getenv(f'RSS_FEED_{i}')
    if feed_url:
        RSS_FEEDS.append(feed_url)
        i += 1
    else:
        break

# Fallback to single RSS_URL if no RSS_FEED_X found
if not RSS_FEEDS:
    rss_url = os.getenv('RSS_URL')
    if rss_url:
        RSS_FEEDS = [rss_url]

# Validate all required variables are set
if not TRAKT_CLIENT_ID or not TRAKT_ACCESS_TOKEN or not TRAKT_LIST_SLUG or not TRAKT_USERNAME:
    print("✗ Missing required Trakt credentials")
    exit(1)

if not RSS_FEEDS:
    print("✗ No RSS feeds configured (use RSS_FEED_1, RSS_FEED_2, etc.)")
    exit(1)

print(f"✓ Configuration loaded: {len(RSS_FEEDS)} RSS feed(s)\n")

# Headers for Trakt API
headers = {
    'Content-Type': 'application/json',
    'trakt-api-version': '2',
    'trakt-api-key': TRAKT_CLIENT_ID,
    'Authorization': f'Bearer {TRAKT_ACCESS_TOKEN}'
}


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
            
            if search_response.status_code == 200 and search_response.json():
                results = search_response.json()
                
                # Filter results to match the year exactly
                for result in results:
                    movie = result['movie']
                    movie_year = str(movie['year'])
                    
                    # Check if year matches exactly
                    if year and movie_year == year:
                        # Additional check: title similarity
                        movie_title_lower = movie['title'].lower()
                        variation_lower = variation.lower()
                        
                        # Accept if titles are very similar
                        if (movie_title_lower in variation_lower or 
                            variation_lower in movie_title_lower or
                            results.index(result) == 0):
                            
                            return movie, result, results
                
        except Exception as e:
            print(f"    Error searching variation '{variation}': {e}")
            continue
    
    return None, None, None


# Fetch RSS feeds
print(f"Fetching {len(RSS_FEEDS)} RSS feed(s)...")
all_entries = []

for i, rss_url in enumerate(RSS_FEEDS, 1):
    print(f"  Feed {i}: {rss_url}")
    feed = feedparser.parse(rss_url)
    print(f"  Found {len(feed.entries)} items")
    all_entries.extend(feed.entries)

print(f"\nTotal items from all feeds: {len(all_entries)}\n")


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
        print(f"  ✗ No exact match found for year {year}")
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
