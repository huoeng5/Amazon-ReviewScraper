# Amazon Review Scraper

Desktop review crawler for Amazon Japan, Rakuten Ichiba, and Yahoo! Shopping. The app stores crawl jobs and public review data in a local SQLite database and provides CSV export from the desktop UI.

## Features

- Electron desktop shell with a React UI.
- Amazon Japan, Rakuten Ichiba, and Yahoo! Shopping product review crawling.
- Persistent local task queue with duplicate URL checks, retry, soft delete, and sequential processing.
- Local SQLite storage with deduplication and incremental-friendly exports.
- Current product CSV export and full database CSV export.

## Requirements

- Node.js 24 or newer. The project uses `node:sqlite`.
- npm.
- Playwright browser dependencies.

## Setup

```bash
npm install
npm install --prefix ui
npx playwright install chromium
```

## Run The Desktop App

```bash
npm run desktop
```

Amazon runs in a visible Chromium session so the user can resolve region, cookie, or verification prompts when needed. Rakuten and Yahoo! Shopping run headless by default.

## CLI Crawlers

```bash
npm run amazon -- --asin B0XXXXXXXX --max-pages 3 --headful --profile-dir .browser-profiles/amazon-jp --manual-resolve
npm run rakuten -- --url "https://item.rakuten.co.jp/shop/item/"
npm run yahoo -- --url "https://store.shopping.yahoo.co.jp/shop/item.html"
```

## Local Data

Runtime data is created locally and is intentionally ignored by Git:

- `data/`
- `exports/`
- `output/`
- `snapshots/`
- `.browser-profiles/`
- `input/`

Do not commit real crawl results, browser profiles, cookies, or SQLite databases.

## Notes

This tool is intended for collecting publicly visible review data for research and operations workflows. Users are responsible for complying with each platform's terms, robots policies, rate limits, and applicable privacy laws.
