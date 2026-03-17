import os
from typing import Optional, Dict

import requests


class OMDbClient:
    def __init__(self, api_key: Optional[str] = None):
        self.api_key = (api_key or os.getenv("OMDB_API_KEY") or "").strip()
        self._cache: Dict[str, Optional[float]] = {}

    def get_imdb_rating(self, imdb_id: str) -> Optional[float]:
        imdb_id = (imdb_id or "").strip()
        if not imdb_id:
            return None
        if imdb_id in self._cache:
            return self._cache[imdb_id]
        if not self.api_key:
            self._cache[imdb_id] = None
            return None
        try:
            r = requests.get(
                "http://www.omdbapi.com/",
                params={"i": imdb_id, "apikey": self.api_key},
                timeout=10,
            )
            if r.status_code != 200:
                self._cache[imdb_id] = None
                return None
            data = r.json() if isinstance(r.json(), dict) else {}
            val = data.get("imdbRating")
            if not val or val == "N/A":
                self._cache[imdb_id] = None
                return None
            rating = float(val)
            rating = round(rating, 1)
            self._cache[imdb_id] = rating
            return rating
        except Exception:
            self._cache[imdb_id] = None
            return None

