# nCore Movie Catalog for Trakt 🎬

Automated script to sync Hungarian HD movies from nCore RSS feeds to Trakt lists.

![Python](https://img.shields.io/badge/python-3.8+-blue.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)

## Features

✅ **Multi-feed RSS parsing** - Support unlimited RSS feeds  
✅ **Smart title matching** - Automatic year extraction & title cleaning  
✅ **Intelligent search** - Tries multiple title variations (e.g., "and" vs "&")  
✅ **Duplicate prevention** - Won't add movies already in your list  
✅ **Secure configuration** - Credentials stored in environment variables  
✅ **Rate limiting** - Respects Trakt API limits  
✅ **Detailed logging** - See exactly what's being added  

## Prerequisites

- Python 3.8 or higher
- Trakt.tv account
- nCore account with RSS access via finderss.it.cx
- Trakt API credentials ([Get here](https://trakt.tv/oauth/applications))

## Installation

### 1. Clone Repository

```bash
git clone https://github.com/YOUR_USERNAME/ncore-catalog-addon.git
cd ncore-catalog-addon
