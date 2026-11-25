# Implementation Plan: «ВИЗИТ» CRM Telegram suite

## Overview

Deliver the approved capability map as a local-first modular Node.js application with SQLite persistence, a Telegram-authenticated Mini App, bot-assisted capture and follow-up, and clear HTTPS deployment steps.

## Architecture decisions

- Keep the current CommonJS/Node.js app and use Node's built-in SQLite API; no runtime package dependencies are required.
- Store application rows as validated JSON plus indexed fields in SQLite; migrate the existing JSON file once and retain it as a backup.
- Split HTTP, persistence, Telegram authentication, and bot features into `src/` modules.
- Require verified Telegram `initData` for remote Mini App/API access; allow loopback development only. Use an optional service token for the local bot process.
- Keep transcription disabled unless an API key is deliberately configured; always preserve the source audio as an application file.
- Build a public HTTPS release configuration, but do not publish or configure a real domain without the user's host details.

## Task list

### Phase 1: Project foundation
- [ ] Initialize local Git, add README and secure ignores.
- [ ] Add SQLite repository and one-time JSON migration.
- [ ] Split server into modular HTTP and application service layers.

### Phase 2: Mini App and access
- [ ] Add Telegram `initData` validation and local-only development access.
- [ ] Build responsive Mini App dashboard, search, pipeline, create/edit, files, history, and CSV export.
- [ ] Set the bot's menu button when a public Mini App URL is configured.

### Phase 3: Bot daily workflow
- [ ] Add private quick menu and safe draft field editing.
- [ ] Add duplicate detection and attach incoming documents/voice notes to existing cards.
- [ ] Add scheduled due-date reminders and daily digest.
- [ ] Add voice-note storage and optional transcription adapter.

### Phase 4: Delivery and verification
- [ ] Document local setup, HTTPS deployment, token/ID settings, voice privacy, and migration behavior.
- [ ] Verify syntax, storage migration, API auth boundaries, Mini App routes, and bot code paths without sending messages or publishing.

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Existing CRM data shape varies | Could lose records during migration | Import rows unchanged, keep original JSON, report migration count |
| Mini App needs a public HTTPS URL | Cannot appear as a live Telegram menu button locally | Keep local preview and gate menu configuration on `TELEGRAM_WEBAPP_URL` |
| Bot token is not configured | Live Telegram behavior cannot be exercised | Complete code/config and document exact activation steps |
| Audio is personal data | Unintended external transfer | Store audio locally; call transcription provider only when its key is set |
| Node SQLite API version | Older Node installations may fail | Document Node 22.13+ requirement and startup check |
