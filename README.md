# 🇭🇺 nCore Stremio Addons

Automated Hungarian content catalogs from nCore tracker for Stremio. **Series** use TVDB metadata; **movies** and Hungarian filters use TMDB.

![Python](https://img.shields.io/badge/python-3.8+-blue.svg)
![Node.js](https://img.shields.io/badge/node.js-18+-green.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)
[![Live Demo](https://img.shields.io/badge/Live%20Demo-Railway-blueviolet)](https://ncore-catalog-addon-production.up.railway.app/)

## 🎬 Two Addons in One Server

This project serves **two separate Stremio addons** from a single deployment:

### 📺 nCore Katalógus
**Catalog addon** that displays Hungarian movies and series from nCore tracker.

- ✅ **Catalogs:** 🏆 Top Seed (filmek, sorozatok, magyar filmek, magyar sorozatok) + genre filtering; ⏰ Legfrissebb (filmek 2025–2026, sorozatok); ⏰ Streaming: Netflix, Disney+, HBO Max, Prime (legfrissebb filmek/sorozatok)
- ✅ TVDB for series, TMDB for movies (no Trakt)
- ✅ Direct nCore → TVDB/TMDB matching
- ✅ Customizable catalog selection and order on the homepage before install
- ✅ Installation: `https://your-deployment-url/manifest.json`

### 🎬 Magyar Előzetesek (Hungarian Trailers)
**Trailer addon** that provides Hungarian and English trailers for movies and series.

- ✅ **4-stage fallback search**: TMDB hu-HU → YouTube HU → TMDB en-US → YouTube EN
- ✅ Hungarian-first priority (dubbed/subtitled)
- ✅ Season-specific trailers for series
- ✅ Smart YouTube scraping when TMDB has no trailers
- ✅ Works with both movies and TV shows
- ✅ Installation: `https://your-deployment-url/trailers/manifest.json`

## 🌐 Live Demo

**🚀 [https://ncore-catalog-addon-production.up.railway.app/](https://ncore-catalog-addon-production.up.railway.app/)**

Visit the deployment to see the homepage with install instructions for all three addons.

### Quick Install URLs:
- 📺 **Catalog:** `https://ncore-catalog-addon-production.up.railway.app/manifest.json`
- ℹ️ **Episode Info:** `https://ncore-catalog-addon-production.up.railway.app/info/manifest.json`
- 🎬 **Trailers:** `https://ncore-catalog-addon-production.up.railway.app/trailers/manifest.json`

## 🚀 Features

### Backend Automation
- 🔄 **nCore Direct Scraping** - Fetches content directly from nCore tracker using ncoreparser
- 🎯 **Smart Title Matching** - Year extraction, title cleaning, multiple variations
- 📊 **TVDB/TMDB Metadata** - Series: TVDB API; movies and Hungarian filter: TMDB API
- ⏰ **Scheduled Updates** - Automated catalog building with incremental updates
- 🔒 **Duplicate Prevention** - Efficient incremental updates avoid re-processing existing items
- 📝 **Episode Tracking** - Monitors latest series uploads with dates

### Stremio Integration
- 📺 **Triple Addons** - Catalog, info, and trailer addons on one server
- 🎨 **TMDB Metadata** - High-quality posters and descriptions
- 🇭🇺 **Hungarian Language** - Titles, descriptions, and posters in Hungarian
- 🔗 **Direct TMDB Integration** - Fast and accurate metadata resolution
- 🎬 **Intelligent Trailer Search** - Multi-stage Hungarian/English fallback

### ⏰ Scheduled Catalog Updates

The server runs catalog build scripts automatically using node-cron (Unix only; on Windows run scripts manually or use a scheduler):

- **⏰ Latest + streaming split:** Every 3 hours — `build_latest_catalog.py` (big HD movies/series, ~2000 items) then `split_catalogs_by_provider.py` (splits into Netflix, Disney+, HBO Max, Prime using TMDB watch providers: Netflix=US, Disney+/HBO Max/Prime=HU).
- **🏆 Top-seeded + Magyar + streaming split:** Weekly Sunday 03:00 — `build_most_seeded_movies_catalog.py` → `filter_hungarian_productions.py` → `build_most_seeded_series_catalog.py` → `filter_hungarian_productions_series.py` → `split_catalogs_by_provider.py`.

Streaming catalogs (Netflix, Disney+, HBO Max, Prime) are **not** built from nCore tags; they are derived from the big catalogs by TMDB “where to watch” (JustWatch) so only titles that are on that provider in the watch region (US) appear.

### Available Catalogs

In Stremio Discover, catalog names appear as:

**🏆 Top Seed**
- 🏆 Filmek – Top-seeded HD-HUN movies (filterable by genre in Stremio)
- 🏆 Sorozatok – Top-seeded series (filterable by genre)
- 🏆 Magyar filmek – Top-seeded Hungarian-produced movies
- 🏆 Magyar sorozatok – Top-seeded Hungarian-produced series

**⏰ Legfrissebb**
- ⏰ Filmek – Latest movie uploads (2025/2026 only)
- ⏰ Sorozatok – Latest series uploads (HD, sports filtered, episode tracking)

**⏰ Streaming**
- ⏰ Netflix filmek / ⏰ Netflix sorozatok – Titles on Netflix (TMDB, US)
- ⏰ Disney+ filmek / ⏰ Disney+ sorozatok – Titles on Disney+ (TMDB, HU)
- ⏰ HBO Max filmek / ⏰ HBO Max sorozatok – Titles on HBO Max (TMDB 1899, HU)
- ⏰ Prime Video filmek / ⏰ Prime Video sorozatok – Titles on Prime Video (TMDB 119, HU)

### How it works

- **Big catalogs:** `build_latest_catalog.py` (hd_movies, hd_series, ~2000 each), `build_most_seeded_movies_catalog.py`, `build_most_seeded_series_catalog.py` (top-seeded). **Series:** match to TVDB → IMDB + metadata; **Movies:** match to TMDB. Hungarian filter scripts produce Magyar filmek/sorozatok from most_seeded.
- **Streaming split:** `split_catalogs_by_provider.py` reads hd_* JSONs, calls TMDB watch/providers per title (Netflix=US, Disney+/HBO Max/Prime=HU), and writes netflix_*, disneyplus_*, hbomax_*, prime_*. Data source: JustWatch (attribution required).
- **Incremental:** build_latest and most_seeded load existing JSON, fetch new torrents, merge and trim.
- **Requirements:** `NCORE_USER`, `NCORE_PASS`, `TMDB_API_KEY`, and `TVDB_API_KEY` in `config/config.env` (see `config/config.example.env`). Optional: `TVDB_PIN` for user-supported TVDB keys.

## 📋 Prerequisites

- Python 3.8+
- Node.js 18+
- nCore.pro account
- TMDB API key ([Get here](https://www.themoviedb.org/settings/api)) — for movies and Hungarian filter
- TVDB API key ([Get here](https://thetvdb.com/dashboard)) — for series catalogs (optional PIN if user-supported key)

## 🛠️ Installation

### 1. Clone Repository
```bash
git clone https://github.com/ottomaior/ncore-catalog-addon.git
cd ncore-catalog-addon
