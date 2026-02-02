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
- ✅ Movies and series catalogs
- ✅ TMDB metadata with Hungarian titles and posters
- ✅ Installation: `https://your-deployment-url/manifest.json`

### ℹ️ nCore Epizód Infó
**Information addon** that shows the latest uploaded Hungarian episode for series.

- ✅ Displays episode number and upload date
- ✅ Only shows for series in the nCore Katalógus list
- ✅ ⚠️ **Not a streaming addon** - information only!
- ✅ Use with Hungarian torrent addon for playback
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
- ⏰ **Scheduled Updates** - Every 3 hours via node-cron
- 🔒 **Duplicate Prevention** - Won't add content already in lists
- 📝 **Episode Tracking** - Monitors latest series uploads with dates

### Stremio Integration
- 📺 **Triple Addons** - Catalog, info, and trailer addons on one server
- 🎨 **TMDB Metadata** - High-quality posters and descriptions
- 🇭🇺 **Hungarian Language** - Titles, descriptions, and posters in Hungarian
- 🔗 **Trakt Integration** - Pulls content from your Trakt lists
- 🎬 **Intelligent Trailer Search** - Multi-stage Hungarian/English fallback

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
