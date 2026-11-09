# Telegram Autopost

Telegram bot + Cloudflare Worker + D1 database for collecting TikTok video links and preparing scheduled channel posts.

## Project details

- Telegram channel: `@zadrot1705`
- Telegram bot: `@Chatgptdobeckobot`
- Time zone: `Asia/Tashkent`
- Intended publishing limit: 3 videos per day

## Current implementation

- Cloudflare Worker entry point: `src/index.js`
- Health endpoint: `GET /health`
- Telegram webhook endpoint: `POST /webhook`
- Accepts TikTok links sent to the bot and stores them in D1.
- Ignores duplicate TikTok URLs.
- Supports `/start`, `/help`, and `/queue`.
- Optional sender restriction via `TELEGRAM_ALLOWED_USER_ID`.

## Database

Apply migrations in order:

1. `migrations/0001_init.sql`
2. `migrations/0002_add_source_chat.sql`

The Worker expects a D1 binding named `DB`.

## Required Worker secrets

Set these as Cloudflare Worker secrets (never commit their values):

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`
- `TELEGRAM_ALLOWED_USER_ID` (recommended; numeric Telegram user ID)

## Not implemented yet

TikTok video downloading, caption generation, comment retrieval, duplicate-content checks beyond URL uniqueness, automatic scheduling, and channel publishing are not implemented yet. A downloader provider and Telegram webhook configuration are still required before end-to-end operation.

## Deployment note

`wrangler.toml` currently contains a placeholder D1 database ID. Replace it with the real database ID before deploying through Wrangler. If deploying from the Cloudflare dashboard, verify the existing D1 binding named `DB` is attached to `telegram_autopost_db`.
