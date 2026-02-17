# 🇭🇺 nCore Stremio Addons

Automated Hungarian content catalogs from nCore tracker for Stremio using TMDB metadata.

![Python](https://img.shields.io/badge/python-3.8+-blue.svg)
![Node.js](https://img.shields.io/badge/node.js-18+-green.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)
[![Live Demo](https://img.shields.io/badge/Live%20Demo-Railway-blueviolet)](https://ncore-catalog-addon-production.up.railway.app/)

## 🎬 Two Addons in One Server

This project serves **two separate Stremio addons** from a single deployment:

### 📺 nCore Katalógus
**Catalog addon** that displays Hungarian movies and series from nCore tracker.

- ✅ **Catalogs:** 🏆 Top Seed (filmek, sorozatok, magyar filmek, magyar sorozatok) + genre filtering; ⏰ Legfrissebb (filmek 2025–2026, sorozatok); ⏰ Streaming: Netflix, HBO Max, Prime Video (legfrissebb filmek/sorozatok)
- ✅ TMDB metadata with Hungarian titles and posters (TMDB only, no Trakt)
- ✅ Direct nCore → TMDB matching
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
- 📊 **TMDB Metadata** - Direct TMDB API integration for accurate metadata and genres
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

- **⏰ Latest movies/series:** Every 3 hours — `build_latest_catalog.py` (2025/2026 movies, all HD series; sports filter + episode tracking for series)
- **⏰ Streaming (Netflix, HBO Max, Prime Video):** Every 6 hours — `build_netflix_catalog.py`, `build_hbomax_catalog.py`, `build_primevideo_catalog.py`
- **🏆 Top-seeded + Magyar:** Weekly Sunday 03:00 — `build_most_seeded_movies_catalog.py` → `filter_hungarian_productions.py` → `build_most_seeded_series_catalog.py` → `filter_hungarian_productions_series.py`

All scripts use **incremental mode**: they fetch only new torrents and merge with existing JSON catalogs.

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
- ⏰ Netflix filmek / ⏰ Netflix sorozatok – Latest .nf.1080 releases
- ⏰ HBO Max filmek / ⏰ HBO Max sorozatok – Latest .hmax.1080 releases
- ⏰ Prime Video filmek / ⏰ Prime Video sorozatok – Latest .amzn.1080 releases

### How it works

- **Scripts:** `build_latest_catalog.py`, `build_netflix_catalog.py`, `build_hbomax_catalog.py`, `build_primevideo_catalog.py`, `build_most_seeded_movies_catalog.py`, `build_most_seeded_series_catalog.py`, `filter_hungarian_productions.py`, `filter_hungarian_productions_series.py`
- **Process:** Fetch torrents from nCore (by pattern: e.g. `.nf.1080`, `.hmax.1080`, `.amzn.1080` or top-seeded) → Parse title/year → Match to TMDB (search + details → IMDB ID + metadata) → Write/merge JSON in `data/`
- **Incremental updates:** Scripts load existing JSON, fetch only recent torrents, add new matches, merge and trim to target size
- **Requirements:** `NCORE_USER`, `NCORE_PASS`, and `TMDB_API_KEY` in `config/config.env` (see `config/config.example.env`)

## 📋 Prerequisites

- Python 3.8+
- Node.js 18+
- nCore.pro account
- TMDB API key ([Get here](https://www.themoviedb.org/settings/api))

## 🛠️ Installation

### 1. Clone Repository
```bash
git clone https://github.com/ottomaior/ncore-catalog-addon.git
cd ncore-catalog-addon
