# 🇭🇺 nCore Stremio Addons

Automated Hungarian content catalog sync from nCore RSS feeds to Stremio via Trakt lists.

![Python](https://img.shields.io/badge/python-3.8+-blue.svg)
![Node.js](https://img.shields.io/badge/node.js-18+-green.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)
[![Live Demo](https://img.shields.io/badge/Live%20Demo-Railway-blueviolet)](https://ncore-catalog-addon-production.up.railway.app/)

## 🎬 Three Addons in One Server

This project serves **three separate Stremio addons** from a single deployment:

### 📺 nCore Katalógus
**Catalog addon** that displays Hungarian movies and series from nCore tracker.

- ✅ Synced from Trakt lists every 3 hours
- ✅ **Catalogs:** Utoljára feltöltött (movies + series), **Legnagyobb seed (összes)** + by genre (Comedy, Action, War, …)
- ✅ TMDB metadata with Hungarian titles and posters
- ✅ Installation: `https://your-deployment-url/manifest.json`

### ℹ️ nCore Epizód Infó
**Information addon** that shows the latest uploaded Hungarian episode for series.

- ✅ Displays episode number and upload date
- ✅ Only shows for series in the nCore Katalógus list
- ✅ ⚠️ **Not a streaming addon** - information only!
- ✅ Use with a Hungarian streaming addon for playback
- ✅ Installation: `https://your-deployment-url/info/manifest.json`

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
- 🔄 **RSS Feed Scraping** - Parses nCore RSS feeds via finderss.it.cx
- 🎯 **Smart Title Matching** - Year extraction, title cleaning, multiple variations
- 📊 **Trakt Sync** - Automatically adds new content to Trakt lists
- ⏰ **Scheduled Updates** - Every 3 hours (in-app node-cron on Railway, or optional GitHub Actions webhook)
- 🔒 **Duplicate Prevention** - Won't add content already in lists
- 📝 **Episode Tracking** - Monitors latest series uploads with dates

### Stremio Integration
- 📺 **Triple Addons** - Catalog, info, and trailer addons on one server
- 🎨 **TMDB Metadata** - High-quality posters and descriptions
- 🇭🇺 **Hungarian Language** - Titles, descriptions, and posters in Hungarian
- 🔗 **Trakt Integration** - Pulls content from your Trakt lists
- 🎬 **Intelligent Trailer Search** - Multi-stage Hungarian/English fallback

### ⏰ Scheduled sync (every 3 hours)

**GitHub Actions** runs both sync scripts every 3 hours (workflow: `Cron sync RSS to Trakt`). You only need to add the secrets below.

On **Railway**, the server can also run the scripts in-process (node-cron); the Actions cron runs regardless so your lists stay in sync even if the app is asleep.

---

**Add these GitHub Secrets** (repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**):

| Secret | Required | Where to get it |
|--------|----------|-----------------|
| `TRAKT_CLIENT_ID` | Yes | [Trakt API](https://trakt.tv/oauth/applications) |
| `TRAKT_ACCESS_TOKEN` | Yes | From `config.env` or [auth flow](https://trakt.tv/oauth/applications) |
| `TRAKT_CLIENT_SECRET` | Yes | Trakt API application |
| `TRAKT_REFRESH_TOKEN` | Yes | From `config.env` / auth flow |
| `TRAKT_LIST_SLUG` | Yes | Your Trakt list slug (movies) |
| `TRAKT_SERIES_LIST_SLUG` | Yes | Your Trakt list slug (series) |
| `TRAKT_USERNAME` | Yes | Your Trakt username |
| `RSS_FEED_MOVIES_1`, `RSS_FEED_MOVIES_2` | No | Custom movie RSS URLs (optional; scripts use defaults if missing) |
| `NCORE_USER`, `NCORE_PASS` | For top-seeded catalog | nCore.pro login (for **Legnagyobb seed** film catalogs built from JSON) |

After adding the 7 required secrets, the workflow will run every 3 hours and on **Run workflow** from the Actions tab.

### nCore Movies: Latest + Top seeded (all + by genre)

In Stremio Discover, under **nCore – Movies** you get:

- **Utoljára feltöltött** – Latest uploads (from Trakt list, updated every 3 h).
- **Legnagyobb seed (összes)** – All top-seeded HD-HUN movies from one JSON file (no extra Trakt list).
- **Legnagyobb seed – Comedy / Action / War / Drama / …** – Same list filtered by genre.

The big list is built **weekly** (Sunday 03:00) so nCore is not hit too often. A script fetches HD-HUN movies from nCore (aiming for 4000), matches to Trakt/TMDB (with genres), and writes `data/most_seeded_movies.json`. The addon reads that file and serves "Top Seed – Összes" and "Top Seed – {genre}" from it.

- **Script:** `python scripts/build_most_seeded_movies_catalog.py` (run once manually or let the 3-day cron do it).
- **Output:** `data/most_seeded_movies.json` (gitignored). Needs `NCORE_USER`, `NCORE_PASS`, Trakt and TMDB keys in config.
- **Note:** ncoreparser may return one batch per run (~25–50). For 1000+ items you may need pagination support in the library or run the script with different strategies when available.

## 📋 Prerequisites

- Python 3.8+
- Node.js 18+
- Trakt.tv account with API credentials ([Get here](https://trakt.tv/oauth/applications))
- nCore account with RSS access via finderss.it.cx
- TMDB API key ([Get here](https://www.themoviedb.org/settings/api))

## 🛠️ Installation

### 1. Clone Repository
```bash
git clone https://github.com/ottomaior/ncore-catalog-addon.git
cd ncore-catalog-addon
