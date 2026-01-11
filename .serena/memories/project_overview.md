Purpose: Telegram bot for calculation/balance tracking with daily transaction reports and PDF export.
Tech stack: Node.js JavaScript (ESM), grammy (Telegram bot), mongodb, dotenv, pdf-lib, Playwright for PDF rendering.
Structure: `index.js` holds bot logic/handlers and MongoDB integration; `logs/` stores JSONL audit logs; `package.json` defines deps/scripts; `.env` provides runtime config; `report_template.pdf` is the PDF template; `fonts/` contains assets.
Entrypoint: `node index.js` runs the bot in polling mode.
Config: `.env` with `BOT_TOKEN`, `MONGO_URI`, optional `MONGO_DB` (default `calculation_bot`), `TIMEZONE` (default UTC unless overridden).