# Capability Map: Telegram bot and CRM Mini App

## Objective

Make Telegram the quick-entry and daily-work surface for the «ВИЗИТ» CRM, with a Mini App that exposes the CRM workflow on mobile and desktop Telegram clients.

## Assumptions

- Build a modular monolith in the existing Node.js project so it remains straightforward to run on Windows.
- Keep CRM data on the server behind a repository interface; start with a local database and allow a hosted database adapter later.
- Verify Telegram Mini App `initData` on the server before exposing CRM data or write actions.
- Keep voice transcription behind a provider interface. Audio is private client data; provider credentials and any external transfer must be explicitly configured.
- Mini App deployment and the bot's menu button require a public HTTPS URL. Local development remains available without it.
- Existing `data/applications.json` records and attachments must survive any storage migration.

## Modules

| Module id | Responsibility | Depends on |
|---|---|---|
| `crm-core` | Modular HTTP API, validation, Telegram session auth, application repository, migration of current JSON records | — |
| `miniapp` | Responsive Telegram Mini App with dashboard, search, list, pipeline, create/edit card, history, files, CSV export | `crm-core` |
| `bot-workflow` | Private quick menu, safe capture, editable import drafts, duplicate detection and attaching material to an existing application | `crm-core` |
| `reminders` | Due-date reminders, configurable daily digest, delivery preferences and delivery log | `crm-core`, `bot-workflow` |
| `voice-notes` | Receive voice messages, associate them with a selected application, preserve audio and optionally transcribe through a configured adapter | `crm-core`, `bot-workflow` |
| `release` | Local setup, HTTPS hosting configuration, Telegram Mini App/menu setup and operational documentation | `crm-core`, `miniapp`, `bot-workflow`, `reminders`, `voice-notes` |

## Build order

`crm-core` → `miniapp` and `bot-workflow` → `reminders` and `voice-notes` → `release`.

## Acceptance outcomes

- All six requested conveniences are usable from the private bot chat.
- The Mini App covers the CRM's core list, search, pipeline, application editing, due dates, history, source files and CSV export.
- Only valid Telegram sessions can read or change CRM records through the Mini App.
- Existing CRM data survives the structural changes.
- Bot secrets, database credentials and transcription credentials stay outside source control.
- Local launch works; public Telegram launch is documented and ready to enable when the HTTPS host is configured.

## Decisions still needed before a live launch

- Public HTTPS host and its URL.
- Whether voice transcription may send audio to an external provider, and provider credentials; otherwise voice remains a CRM note/audio item without transcription.
