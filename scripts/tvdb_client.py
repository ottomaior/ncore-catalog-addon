"""
TVDB API v4 client for series lookup.
Used by catalog scripts for series only; movies and Hungarian filter stay on TMDB.
"""
import os
import time
import requests

BASE_URL = "https://api4.thetvdb.com/v4"
TVDB_DELAY = 0.4  # Delay between API calls
ARTWORK_BASE = "https://artworks.thetvdb.com/banners/"
TMDB_BASE = "https://api.themoviedb.org/3"
TMDB_DELAY = 0.35  # Delay for TMDB enrichment calls
TMDB_POSTER_PREFIX = "https://image.tmdb.org/t/p/w500"
# TVDB language code for Hungarian (used for translations endpoint)
LANG_HUN = "hun"
# Fallback poster artwork type id if /artwork/types is unavailable (TVDB often uses 2 for poster)
_POSTER_ARTWORK_TYPE_ID = 2
_artwork_type_cache = None


def _ensure_token(apikey, pin=None):
    """Get or refresh TVDB bearer token. Uses module-level cache."""
    if not apikey:
        return None
    payload = {"apikey": apikey}
    if pin:
        payload["pin"] = pin
    try:
        r = requests.post(f"{BASE_URL}/login", json=payload, timeout=10)
        if r.status_code != 200:
            return None
        return r.json().get("data", {}).get("token")
    except Exception:
        return None


def _get_imdb_from_remote_ids(remote_ids):
    """Extract IMDB id from TVDB remote_ids (search) or remoteIds (series)."""
    if not remote_ids:
        return None
    for r in remote_ids:
        rid = r.get("id")
        src = (r.get("sourceName") or "").lower()
        if src == "imdb" and rid and str(rid).startswith("tt"):
            return str(rid)
        if rid and str(rid).startswith("tt"):
            return str(rid)
    return None


def _get_poster_artwork_type_id(headers):
    """Get TVDB artwork type id for 'poster'. Cached after first successful call."""
    global _artwork_type_cache
    if _artwork_type_cache is not None:
        return _artwork_type_cache
    try:
        time.sleep(TVDB_DELAY)
        r = requests.get(f"{BASE_URL}/artwork/types", headers=headers, timeout=10)
        if r.status_code != 200:
            _artwork_type_cache = _POSTER_ARTWORK_TYPE_ID
            return _artwork_type_cache
        for item in (r.json().get("data") or []):
            name = (item.get("name") or "").strip().lower()
            if name == "poster":
                _artwork_type_cache = int(item.get("id", _POSTER_ARTWORK_TYPE_ID))
                return _artwork_type_cache
        _artwork_type_cache = _POSTER_ARTWORK_TYPE_ID
        return _artwork_type_cache
    except Exception:
        _artwork_type_cache = _POSTER_ARTWORK_TYPE_ID
        return _artwork_type_cache


def _get_series_poster_for_lang(headers, tvdb_id, lang=LANG_HUN):
    """
    Fetch series poster for the given language (e.g. Hungarian).
    Returns full image URL or None if no poster for that language.
    """
    if not tvdb_id:
        return None
    poster_type_id = _get_poster_artwork_type_id(headers)
    try:
        time.sleep(TVDB_DELAY)
        r = requests.get(
            f"{BASE_URL}/series/{tvdb_id}/artworks",
            headers=headers,
            params={"lang": lang, "type": poster_type_id},
            timeout=10,
        )
        if r.status_code != 200:
            return None
        data = r.json().get("data") or {}
        artworks = data.get("artworks") or []
        for art in artworks:
            img = (art.get("image") or "").strip()
            if img:
                if not img.startswith("http"):
                    img = ARTWORK_BASE.rstrip("/") + "/" + img.lstrip("/")
                return img
        return None
    except Exception:
        return None


def _get_series_translation(headers, tvdb_id, lang=LANG_HUN):
    """
    Fetch series translation for the given language.
    Returns dict with 'name' and 'overview' (or empty strings) if available; None on error/missing.
    """
    if not tvdb_id:
        return None
    try:
        time.sleep(TVDB_DELAY)
        r = requests.get(
            f"{BASE_URL}/series/{tvdb_id}/translations/{lang}",
            headers=headers,
            timeout=10,
        )
        if r.status_code != 200:
            return None
        data = r.json().get("data") or {}
        return {
            "name": (data.get("name") or "").strip(),
            "overview": (data.get("overview") or "").strip(),
        }
    except Exception:
        return None


def _enrich_series_from_tmdb(imdb_id, tmdb_key):
    """
    Fetch TMDB TV details by IMDB id (hu-HU) for Hungarian name, overview, poster, rating, genres.
    Returns dict with title, description, poster_path, rating, genres or None.
    """
    if not tmdb_key or not imdb_id:
        return None
    try:
        time.sleep(TMDB_DELAY)
        r = requests.get(
            f"{TMDB_BASE}/find/{imdb_id}",
            params={"api_key": tmdb_key, "external_source": "imdb_id"},
            timeout=10,
        )
        if r.status_code != 200:
            return None
        tv_results = r.json().get("tv_results") or []
        if not tv_results:
            return None
        tmdb_id = tv_results[0].get("id")
        if not tmdb_id:
            return None
        time.sleep(TMDB_DELAY)
        r2 = requests.get(
            f"{TMDB_BASE}/tv/{tmdb_id}",
            params={"api_key": tmdb_key, "language": "hu-HU"},
            timeout=10,
        )
        if r2.status_code != 200:
            return None
        tv = r2.json()
        name = (tv.get("name") or "").strip()
        overview = (tv.get("overview") or "").strip()
        poster_path = tv.get("poster_path")
        if poster_path and not poster_path.startswith("http"):
            poster_path = TMDB_POSTER_PREFIX + poster_path
        vote_average = tv.get("vote_average")
        genres = [g.get("name", "") for g in (tv.get("genres") or []) if g.get("name")]
        return {
            "title": name or None,
            "description": overview or None,
            "poster_path": poster_path,
            "rating": float(vote_average) if vote_average is not None else None,
            "genres": genres,
        }
    except Exception:
        return None


def search_show_on_tvdb(clean_title, year, apikey, pin=None, tmdb_api_key=None):
    """
    Search for a TV series on TVDB v4 and return metadata in the same shape
    as search_show_on_tmdb: imdb_id, title, poster_path, genres, description, year, rating.
    If tmdb_api_key is set, enriches with TMDB (hu-HU) for name, description, poster, rating, genres when available.
    """
    token = _ensure_token(apikey, pin)
    if not token:
        return None

    headers = {"Authorization": f"Bearer {token}"}
    variations = [
        clean_title,
        clean_title.replace(" and ", " & "),
        clean_title.replace(" & ", " and "),
    ]

    for variation in variations:
        try:
            time.sleep(TVDB_DELAY)
            params = {"query": variation, "type": "series"}
            if year:
                params["year"] = int(year)
            r = requests.get(
                f"{BASE_URL}/search",
                params=params,
                headers=headers,
                timeout=10,
            )
            if r.status_code != 200:
                continue
            data = r.json().get("data") or []
            if not data:
                continue

            # Prefer a result that has IMDB in remote_ids (search returns remote_ids)
            item = None
            imdb_id = None
            for candidate in data:
                imdb_id = _get_imdb_from_remote_ids(candidate.get("remote_ids") or [])
                if imdb_id:
                    item = candidate
                    break
            if not item:
                item = data[0]
            if not imdb_id:
                # Fetch extended to get remoteIds
                tvdb_id = item.get("tvdb_id") or item.get("id")
                if not tvdb_id:
                    continue
                time.sleep(TVDB_DELAY)
                r2 = requests.get(
                    f"{BASE_URL}/series/{tvdb_id}/extended",
                    headers=headers,
                    params={"short": "true"},
                    timeout=10,
                )
                if r2.status_code != 200:
                    continue
                ext = r2.json().get("data") or {}
                imdb_id = _get_imdb_from_remote_ids(ext.get("remoteIds") or [])
                if imdb_id:
                    item = ext
            if not imdb_id:
                continue

            tvdb_id = item.get("tvdb_id") or item.get("id")
            trans = _get_series_translation(headers, tvdb_id) if tvdb_id else None
            if trans and (trans.get("name") or trans.get("overview")):
                name = trans.get("name") or item.get("name") or item.get("title") or ""
                overview = trans.get("overview") or item.get("overview") or ""
            else:
                name = item.get("name") or item.get("title") or ""
                overview = item.get("overview") or ""
            year_val = item.get("year")
            if isinstance(year_val, str) and year_val.isdigit():
                year_val = int(year_val)
            elif year_val is not None and not isinstance(year_val, int):
                year_val = None
            genres = item.get("genres") or []
            if isinstance(genres, list) and genres and not isinstance(genres[0], str):
                genres = [g.get("name", "") for g in genres if g]
            image = item.get("image") or item.get("image_url") or item.get("poster") or ""
            if image and not image.startswith("http"):
                image = ARTWORK_BASE.rstrip("/") + "/" + image.lstrip("/")
            hun_poster = _get_series_poster_for_lang(headers, tvdb_id, LANG_HUN)
            if hun_poster:
                image = hun_poster
            score = item.get("score")

            result = {
                "imdb_id": imdb_id,
                "title": name,
                "poster_path": image or None,
                "genres": genres,
                "description": overview,
                "year": year_val,
                "rating": float(score) if score is not None else None,
            }
            if tmdb_api_key:
                tmdb_data = _enrich_series_from_tmdb(imdb_id, tmdb_api_key)
                if tmdb_data:
                    if tmdb_data.get("title"):
                        result["title"] = tmdb_data["title"]
                    if tmdb_data.get("description") is not None:
                        result["description"] = tmdb_data["description"]
                    if tmdb_data.get("poster_path"):
                        result["poster_path"] = tmdb_data["poster_path"]
                    if tmdb_data.get("rating") is not None:
                        result["rating"] = tmdb_data["rating"]
                    if tmdb_data.get("genres"):
                        result["genres"] = tmdb_data["genres"]
            return result
        except Exception:
            continue
    return None
