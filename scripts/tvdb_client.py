"""
TVDB API v4 client for series lookup.
Used by catalog scripts for series only; movies and Hungarian filter stay on TMDB.
"""
import time
import requests

from catalog_common import _title_similarity

BASE_URL = "https://api4.thetvdb.com/v4"
TVDB_DELAY = 0.4  # Delay between API calls
ARTWORK_BASE = "https://artworks.thetvdb.com/banners/"
TMDB_BASE = "https://api.themoviedb.org/3"
TMDB_DELAY = 0.35  # Delay for TMDB enrichment calls
TMDB_POSTER_PREFIX = "https://image.tmdb.org/t/p/w500"
# TVDB language code for Hungarian (used for translations endpoint)
LANG_HUN = "hun"
# A TVDB search hit must be at least this similar to the nCore title to be accepted (0..1)
MIN_TITLE_SIMILARITY = 0.6
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


def _translation(tv, lang):
    """(name, overview) from the appended TMDB translations for an ISO 639-1 code; empty strings when missing."""
    for tr in ((tv.get("translations") or {}).get("translations") or []):
        if tr.get("iso_639_1") == lang:
            data = tr.get("data") or {}
            return (data.get("name") or "").strip(), (data.get("overview") or "").strip()
    return "", ""


def pick_localized(hu_tmdb, hu_tvdb, en, original):
    """
    Display text for a series: TMDB Hungarian, then the TVDB Hungarian translation, then
    English, then the original-language value. TMDB returns the original name (e.g. Chinese
    or Swedish) when it has no Hungarian translation, so the caller must pass only a real
    Hungarian translation as hu_tmdb.
    """
    for v in (hu_tmdb, hu_tvdb, en, original):
        if v and str(v).strip():
            return str(v).strip()
    return ""


def _enrich_series_from_tmdb(imdb_id, tmdb_key):
    """
    Fetch TMDB TV details by IMDB id for Hungarian name/overview, poster, rating, genres.
    Returns dict with title/description (Hungarian translation only; None when TMDB has none),
    title_en/description_en (English fallback), original_title, poster_path, rating, genres.
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
            params={"api_key": tmdb_key, "language": "hu-HU", "append_to_response": "translations"},
            timeout=10,
        )
        if r2.status_code != 200:
            return None
        tv = r2.json()
        original_name = (tv.get("original_name") or "").strip()
        hu_name, hu_overview = _translation(tv, "hu")
        en_name, en_overview = _translation(tv, "en")
        if tv.get("original_language") == "hu":
            hu_name = hu_name or original_name
        if tv.get("original_language") == "en":
            en_name = en_name or original_name
        if not tv.get("translations"):
            # translations not returned: trust the hu-HU name only when it differs from the original
            name = (tv.get("name") or "").strip()
            hu_name = name if name and name != original_name else ""
            hu_overview = (tv.get("overview") or "").strip()
        poster_path = tv.get("poster_path")
        if poster_path and not poster_path.startswith("http"):
            poster_path = TMDB_POSTER_PREFIX + poster_path
        vote_average = tv.get("vote_average")
        genres = [g.get("name", "") for g in (tv.get("genres") or []) if g.get("name")]
        return {
            "title": hu_name or None,
            "description": hu_overview or None,
            "title_en": en_name or None,
            "description_en": en_overview or None,
            "original_title": original_name or None,
            "poster_path": poster_path,
            "rating": float(vote_average) if vote_average is not None else None,
            "genres": genres,
            "status": tv.get("status") or None,
            "first_air_date": tv.get("first_air_date") or None,
            "last_air_date": tv.get("last_air_date") or None,
        }
    except Exception:
        return None


def _candidate_names(candidate):
    """Every name TVDB search exposes for a candidate: name, aliases, per-language translations."""
    names = [candidate.get("name") or "", candidate.get("title") or ""]
    names += [a for a in (candidate.get("aliases") or []) if isinstance(a, str)]
    trans = candidate.get("translations") or {}
    if isinstance(trans, dict):
        names += [v for v in trans.values() if isinstance(v, str)]
    return [n for n in names if n]


def score_tvdb_candidate(candidate, clean_title, year):
    """
    Score a TVDB /search result against the parsed nCore title: best title similarity over
    the candidate's name, aliases and translations, plus a year bonus / penalty. Mirrors
    score_tmdb_candidate so a Chinese show with a vaguely similar English alias no longer
    beats the real match just because it was listed first with an IMDb id.
    """
    sim = max((_title_similarity(n, clean_title) for n in _candidate_names(candidate)), default=0.0)
    score = sim
    cand_year = candidate.get("year")
    cand_year = int(cand_year) if isinstance(cand_year, (int, str)) and str(cand_year).isdigit() else None
    if year and cand_year:
        diff = abs(int(year) - cand_year)
        if diff == 0:
            score += 0.30
        elif diff == 1:
            score += 0.15
        else:
            score -= 0.20
    return score


def rank_tvdb_results(results, clean_title, year, min_similarity=MIN_TITLE_SIMILARITY, slack=0.15):
    """
    Candidates worth resolving, best score first. A candidate needs a name at least
    min_similarity like the query, and no more than `slack` below the best similarity seen:
    when an exact match exists but cannot be resolved to an IMDb id, a merely similar
    show (The Perfect Couple for The Perfect Lie) must not be accepted in its place.
    """
    sims = [max((_title_similarity(n, clean_title) for n in _candidate_names(c)), default=0.0)
            for c in results[:10]]
    if not sims:
        return []
    floor = max(min_similarity, max(sims) - slack)
    scored = [(score_tvdb_candidate(c, clean_title, year), -i, c)
              for i, (c, sim) in enumerate(zip(results[:10], sims)) if sim >= floor]
    scored.sort(key=lambda x: (x[0], x[1]), reverse=True)
    return [c for _, _, c in scored]


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
    # Year-restricted searches first; a release year is often the upload year of an
    # older show, so retry the same names without the year before giving up.
    attempts = [(v, year) for v in variations] + ([(v, None) for v in variations] if year else [])

    for variation, search_year in attempts:
        try:
            time.sleep(TVDB_DELAY)
            params = {"query": variation, "type": "series"}
            if search_year:
                params["year"] = int(search_year)
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

            # Best title match first; take the first one we can resolve to an IMDb id.
            item = None
            imdb_id = None
            for candidate in rank_tvdb_results(data, clean_title, year):
                imdb_id = _get_imdb_from_remote_ids(candidate.get("remote_ids") or [])
                if imdb_id:
                    item = candidate
                    break
                cand_id = candidate.get("tvdb_id") or candidate.get("id")
                if not cand_id:
                    continue
                time.sleep(TVDB_DELAY)
                r2 = requests.get(
                    f"{BASE_URL}/series/{cand_id}/extended",
                    headers=headers,
                    params={"short": "true"},
                    timeout=10,
                )
                if r2.status_code != 200:
                    continue
                ext = r2.json().get("data") or {}
                imdb_id = _get_imdb_from_remote_ids(ext.get("remoteIds") or [])
                if imdb_id:
                    ext.setdefault("year", candidate.get("year"))
                    ext.setdefault("image", candidate.get("image_url") or candidate.get("image"))
                    ext.setdefault("translations", candidate.get("translations"))
                    item = ext
                    break
            if not imdb_id:
                continue

            tvdb_id = item.get("tvdb_id") or item.get("id")
            trans = _get_series_translation(headers, tvdb_id) if tvdb_id else None
            hun_name = (trans or {}).get("name") or ""
            hun_overview = (trans or {}).get("overview") or ""
            original_name = item.get("name") or item.get("title") or ""
            name = hun_name or original_name
            overview = hun_overview or item.get("overview") or ""
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
                    result["title"] = pick_localized(
                        tmdb_data.get("title"), hun_name, tmdb_data.get("title_en"),
                        original_name or tmdb_data.get("original_title"),
                    ) or name
                    result["description"] = pick_localized(
                        tmdb_data.get("description"), hun_overview, tmdb_data.get("description_en"), overview,
                    )
                    if tmdb_data.get("poster_path"):
                        result["poster_path"] = tmdb_data["poster_path"]
                    if tmdb_data.get("rating") is not None:
                        result["rating"] = tmdb_data["rating"]
                    if tmdb_data.get("genres"):
                        result["genres"] = tmdb_data["genres"]
                    for key in ("status", "first_air_date", "last_air_date"):
                        if tmdb_data.get(key):
                            result[key] = tmdb_data[key]
            return result
        except Exception:
            continue
    return None


def is_netflix_series_by_imdb(imdb_id, apikey, pin=None):
    """
    Return True if TVDB lists Netflix as network/company for this series (by IMDB id).
    Used as fallback when TMDB watch/providers have no data yet (e.g. brand-new shows).
    """
    if not imdb_id or not apikey or not str(imdb_id).strip().lower().startswith("tt"):
        return False
    token = _ensure_token(apikey, pin)
    if not token:
        return False
    headers = {"Authorization": f"Bearer {token}"}
    try:
        time.sleep(TVDB_DELAY)
        r = requests.get(
            f"{BASE_URL}/search/remoteid/{imdb_id.strip()}",
            headers=headers,
            timeout=10,
        )
        if r.status_code != 200:
            return False
        raw = r.json().get("data")
        if not raw:
            return False
        # API can return single object or list of results
        items = raw if isinstance(raw, list) else [raw]
        series_id = None
        for it in items:
            s = it.get("series") if isinstance(it, dict) else None
            if s and (s.get("id") or s.get("tvdb_id")):
                series_id = s.get("id") or s.get("tvdb_id")
                break
        if not series_id:
            return False
        time.sleep(TVDB_DELAY)
        r2 = requests.get(
            f"{BASE_URL}/series/{series_id}/extended",
            headers=headers,
            params={"short": "true"},
            timeout=10,
        )
        if r2.status_code != 200:
            return False
        ext = r2.json().get("data") or {}
        names = []
        for comp in (ext.get("originalNetwork"), ext.get("latestNetwork")):
            if isinstance(comp, dict) and comp.get("name"):
                names.append((comp.get("name") or "").lower())
        companies = ext.get("companies") or {}
        if isinstance(companies, dict):
            for key in ("studio", "network", "production", "distributor", "special_effects"):
                for c in (companies.get(key) or []):
                    if isinstance(c, dict) and c.get("name"):
                        names.append((c.get("name") or "").lower())
        elif isinstance(companies, list):
            for c in companies:
                if isinstance(c, dict) and c.get("name"):
                    names.append((c.get("name") or "").lower())
        return any("netflix" in n for n in names if n)
    except Exception:
        return False
