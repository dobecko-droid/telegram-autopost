# Telegram Autopost

Telegram bot + Cloudflare Worker + D1 database for collecting TikTok video links and preparing channel posts.

## Project details

- Telegram channel: `@zadrot1705`
- Telegram bot: `@Chatgptdobeckobot`
- Time zone: `Asia/Tashkent`
- Intended publishing limit: 3 videos per day
- Default publication times: 10:00, 15:00, 20:00 Tashkent time

## Implemented

- `GET /health` health endpoint.
- `POST /webhook` Telegram webhook with secret-token validation.
- Accept TikTok links sent to the bot and store them in D1.
- Ignore duplicate TikTok URLs.
- `/start`, `/help`, and `/queue` commands.
- Optional sender restriction via `TELEGRAM_ALLOWED_USER_ID`.
- Cloudflare Cron trigger checks every five minutes.
- Ready videos with a populated `video_file_url` are assigned the next available daily slot and sent to the Telegram channel when due.

## Database migrations

Apply in order:

1. `migrations/0001_init.sql`
2. `migrations/0002_add_source_chat.sql`

The Worker expects a D1 binding named `DB` attached to `telegram_autopost_db`.

## Required Worker secrets

Set these as Cloudflare Worker secrets. Never commit their values:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`
- `TELEGRAM_ALLOWED_USER_ID` (recommended; numeric Telegram user ID)

## Still required before end-to-end operation

- Replace the placeholder D1 database ID in `wrangler.toml` if deploying with Wrangler. When deploying from the Cloudflare dashboard, verify the existing `DB` binding is attached to `telegram_autopost_db`.
- Apply the D1 migrations.
- Configure the Telegram webhook URL and secret token.
- Connect a TikTok downloader/provider that fills `video_file_url`, author information, and caption. This is not implemented yet.
- Test channel permissions and an end-to-end post.

The scheduler does not download TikTok videos itself. It only publishes records already marked `ready` with a working video URL.
