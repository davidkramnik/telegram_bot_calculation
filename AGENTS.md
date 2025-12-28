# Repository Guidelines

## Project Structure & Module Organization
- `index.js` contains the Telegram bot logic, handlers, and MongoDB integration.
- `logs/` stores JSONL audit logs written by the bot at runtime.
- `package.json` defines dependencies and npm scripts.
- `node_modules/` is installed dependencies and should not be committed.

## Build, Test, and Development Commands
- `npm install` installs dependencies.
- `node index.js` starts the bot in polling mode.
- `npm test` currently fails by design (`no test specified`) and is a placeholder.

## Configuration & Environment
- Create a `.env` file with required variables:
  - `BOT_TOKEN` (required), `MONGO_URI` (required), `MONGO_DB` (optional, defaults to `calculation_bot`).
  - `TIMEZONE` (optional, defaults to `UTC`).
  - `ALLOW_PLAIN_CODES` and `REQUIRE_MENTION` for message handling behavior.
- Local log output is written to `logs/calculation-log.jsonl`.

## Coding Style & Naming Conventions
- JavaScript (ESM) with 2-space indentation.
- Use `camelCase` for variables/functions and `SCREAMING_SNAKE_CASE` for constants.
- Prefer short, descriptive handler names (e.g., `handleCalculation`, `buildTodayReportForUser`).
- Keep bot replies concise and consistent with existing wording.

## Testing Guidelines
- No automated tests are defined yet.
- If adding tests, use a common Node.js test runner and name files `*.test.js`.
- Document how to run tests in `package.json` when you add them.

## Commit & Pull Request Guidelines
- Recent commits use short, sentence-style subjects (e.g., "Fixed InlineKeyboard issue").
- Use concise, imperative summaries and mention user-visible behavior changes.
- PRs should include: a brief description, any relevant config changes, and sample chat interactions if behavior changed.
