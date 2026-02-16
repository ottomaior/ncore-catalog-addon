# 🇭🇺 nCore Stremio Addons

Automated Hungarian content catalogs from nCore tracker for Stremio using TMDB metadata.

![Python](https://img.shields.io/badge/python-3.8+-blue.svg)
![Node.js](https://img.shields.io/badge/node.js-18+-green.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)
[![Live Demo](https://img.shields.io/badge/Live%20Demo-Railway-blueviolet)](https://ncore-catalog-addon-production.up.railway.app/)

## 🎬 Three Addons in One Server

This project serves **three separate Stremio addons** from a single deployment:

### 📺 nCore Katalógus
**Catalog addon** that displays Hungarian movies and series from nCore tracker.

- ✅ **Catalogs:** Legfrissebb (latest movies + series), Legfrissebb Netflix (latest Netflix releases), **Legnagyobb seed (top-seeded movies + series)** + genre filtering
- ✅ TMDB metadata with Hungarian titles and posters
- ✅ Direct nCore → TMDB matching (no Trakt dependency)
- ✅ Installation: `https://your-deployment-url/manifest.json`

### 🎬 Magyar Előzetesek (Hungarian Trailers) ⭐ NEW
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

The server runs catalog build scripts automatically using node-cron:

- **Latest Movies/Series**: Every 3 hours (incremental updates)
- **Netflix Movies/Series**: Every 6 hours (incremental updates)
- **Top-Seeded Movies/Series**: Weekly on Sunday at 03:00 (incremental updates)

All scripts use **incremental mode** - they only fetch new torrents and merge with existing catalogs, making updates fast and efficient.

### Available Catalogs

In Stremio Discover, you get:

**Movies:**
- **nCore – Legtöbb seed – Filmek** – Top-seeded HD-HUN movies (filterable by genre in Stremio)
- **nCore – Legfrissebb filmek (összes)** – Latest movie uploads (only 2025/2026 releases)
- **nCore – Legfrissebb Netflix Filmek** – Latest Netflix movie releases
- **nCore – Legtöbb seed – Magyar filmek** – Top-seeded Hungarian-produced movies

**Series:**
- **nCore – Legtöbb seed – Sorozatok** – Top-seeded series (filterable by genre in Stremio)
- **nCore – Legfrissebb sorozatok** – Latest series uploads (all HD series)
- **nCore – Legfrissebb Netflix Sorozatok** – Latest Netflix series releases
- **nCore – Legtöbb seed – Magyar sorozatok** – Top-seeded Hungarian-produced series

### How it works

- **Scripts:** `build_most_seeded_movies_catalog.py`, `build_most_seeded_series_catalog.py`, `build_netflix_catalog.py`
- **Process:** Fetch torrents from nCore → Match to TMDB (get IMDB ID + metadata) → Write JSON catalogs
- **Incremental updates:** Only fetch new items, merge with existing, keep catalogs fast and efficient
- **Requirements:** `NCORE_USER`, `NCORE_PASS`, and `TMDB_API_KEY` in config

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
