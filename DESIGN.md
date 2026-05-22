# Task App — System Design Document

> **Living document.** Updated after each phase. For setup instructions see `README.md`.

---

## Overview

A Progressive Web App (PWA) that surfaces Notion tasks on a daily dashboard, enriched with SPIRE wellness tracking, relationship management (Keep In Touch), and automated syncs from Google Calendar, Gmail, and iMessage. Hosted on Vercel; scheduled automations run via a combination of launchd/Shortcuts on a Mac Mini and Cowork AI scheduled tasks.

---

## Architecture

```
iPhone / Browser
      │
      ▼
  Vercel (task-app PWA)
      │  REST
      ▼
  Notion API
      │
  ┌───┴────────────────────────────────────────────────┐
  │  Notion Workspace                                   │
  │  ├── 🎒 To-Do DB                                   │
  │  ├── 🤝 KIT Tracker DB                             │
  │  ├── 📚 Media DB (articles, Feedly)                │
  │  └── Active Life page                              │
  │        └── 📅 Daily Command Center                 │
  │                └── ☀️ Morning Briefings            │
  └────────────────────────────────────────────────────┘
      ▲                    ▲                    ▲
      │                    │                    │
  Mac Mini             Mac Mini            Cowork AI
  Shortcuts.app        (scripts)           Scheduled Tasks
  (Full Disk Access)   ├── kit_sync.py    (~25 automated jobs)
      │                ├── gmail_sync.py
  chat.db              ├── calendar_sync.py
  (iMessage)           └── imessage_export.py
                            │
                       Anthropic API
                       (Claude Haiku)
```

### Why two automation layers?

- **Mac Mini + Shortcuts**: Required for anything that needs Full Disk Access (chat.db / iMessages). Shortcuts.app holds FDA; launchd triggers Shortcuts; Shortcuts runs Python scripts.
- **Cowork Scheduled Tasks**: Everything else — Notion queries, Gmail, Calendar, article management, morning briefings. Runs in the cloud; no Mac dependency.

---

## SPIRE Framework

SPIRE is a five-dimension wellbeing model from Tal Ben-Shahar's Happiness Studies Academy.

| Dimension | Meaning |
|-----------|---------|
| **S** — Spiritual | Living with purpose and meaning; savouring the present moment |
| **P** — Physical | Mind-body connection: nutrition, exercise, rest/recovery |
| **I** — Intellectual | Curiosity, deep learning, open-minded engagement |
| **R** — Relational | Nurturing relationships with others and oneself |
| **E** — Emotional | Building resilience, processing painful emotions, cultivating positive ones |

> **Note:** E = **Emotional** (not Economic). The To-Do DB Notion field uses the full labels: `S — Spiritual`, `P — Physical`, `I — Intellectual`, `R — Relational`, `E — Emotional`.

### SPIRE Classification Logic (Calendar Events)

| Event type | SPIRE dimension |
|------------|----------------|
| Therapy, journaling, reflection | E — Emotional |
| Work blocks, reading, learning | I — Intellectual |
| Travel / flights / hotels | I — Intellectual |
| Social / friends / family | R — Relational |
| Exercise, haircuts, medical appointments | P — Physical |
| Spiritual practices, church, meditation | S — Spiritual |

---

## Notion Databases

### 🎒 To-Do DB
**ID:** `64204e6b-365f-836c-8379-8111f9c55f5a`  
**Collection ID:** `27404e6b-365f-82c9-98e2-07e23624bec8`

| Property | Type | Notes |
|----------|------|-------|
| Name | Title | Task name |
| Status | Status | Not started / In progress / Waiting / Done / Backlog |
| Due Date | Date | Supports time component |
| Priority | Select | High 🔥 / Medium / Low |
| SPIRE | Multi-select | S — Spiritual / P — Physical / I — Intellectual / R — Relational / E — Emotional |
| Notes | Text | Optional; URL extracted from here if no URL field |
| URL | URL | Article / resource link |
| Date Completed | Date | Set on completion |
| Recurrence | Select | None / Daily / Weekly / Bi-weekly / Every 3 Weeks / Every 4 Weeks / Monthly / Every 6 Weeks / Quarterly / Annually |
| Recurrence Template | Checkbox | If true, task is a template; spawn button creates instances |
| Tags | Text | Free-form tags (used for articles, To Do App filtering, etc.) |
| Summary | Text | Short summary field |
| Project | Relation | Links to Projects DB |
| Parent Task / Subtasks | Relation | Self-referential task hierarchy |

### 🤝 Keep in Touch (KIT) Tracker DB
**ID:** `44f5fdf6-c4b5-42ed-a97b-5a667ffebd13`

| Property | Type | Notes |
|----------|------|-------|
| Name | Title | Contact name |
| Phone | Phone | Primary iMessage handle; matched on last 10 digits |
| Email | Email | For email-based Apple IDs or email contacts |
| iMessage Handle | Rich text | Email-format Apple ID (e.g. frank@example.com) for email-based iMessage |
| Reach Out Every | Select | 1 week / 2 weeks / 1 month / 2 months / 3 months / 6 months (also accepts legacy aliases) |
| Last Contact | Date | Updated by kit_sync.py, gmail_sync.py, or calendar_sync.py |
| Next Reach Out | Date | Computed: Last Contact + interval from Reach Out Every |
| Last Method of Contact | Select | SMS/iMessage / Email / Calendar / WhatsApp / etc. |
| Last Conversation | Rich text | 1–2 sentence Claude Haiku summary of most recent exchange |

### 📚 Media DB (Articles)
Houses articles from Feedly inbox and manual additions. Linked to To-Do tasks via article reading tasks.

---

## Scripts (`scripts/`)

All scripts are deployed to `~/Library/Scripts/` on the Mac Mini via `deploy_kit_sync.command`.

### `kit_helpers.py` — Shared Utilities
Imported by `kit_sync.py`, `gmail_sync.py`, and `calendar_sync.py`. Contains:
- `notion_request()` — authenticated Notion API calls with SSL fix
- `get_kit_records()` — paginated fetch of all KIT contacts
- `extract_kit_fields()` — parses raw Notion page into a flat dict
- `update_kit_record()` — PATCH a KIT page (Last Contact, Next Reach Out, Last Conversation, Last Method)
- `summarise_with_claude()` — calls Claude Haiku to produce a 1–2 sentence conversation summary
- `upsert_kit_todo()` / `create_kit_todo()` / `find_existing_kit_todo()` — manage "Reach out to X" To-Do tasks
- `compute_next_reach_out()` / `reach_out_every_to_days()` — date arithmetic
- `normalise_phone()` — strips country code, returns last 10 digits
- `_ssl_ctx()` — macOS SSL fix (see DD7)

**REACH_OUT_DAYS mapping:**
| Option | Days |
|--------|------|
| 1 week / Weekly | 7 |
| 2 weeks / Fortnightly | 14 |
| Every 4 Weeks | 28 |
| 1 month / Monthly | 30 |
| 2 months / Every 2 Months | 60 |
| 3 months / Every 3 Months | 90 |
| 6 months / Every 6 Months | 180 |
| Yearly | 365 |

---

### `kit_sync.py` — iMessage → KIT Tracker
**Triggered by:** `imessage-kit-sync` Cowork scheduled task (7:38 AM daily) via Shortcuts → KitSyncRunner.app  
**Requires:** `NOTION_TOKEN`, `ANTHROPIC_API_KEY`, `NOTION_DATABASE_ID`

**What it does:**
1. Copies `~/Library/Messages/chat.db` to a temp file (avoids locking)
2. Queries sent messages from last 30 days, groups by handle
3. Normalises phone numbers; matches against KIT contacts' Phone and iMessage Handle fields
4. For each contact with a newer send date than their stored Last Contact:
   - Fetches the full message thread between old and new contact date
   - Calls Claude Haiku to produce a 1–2 sentence summary
   - Updates Notion: Last Contact, Next Reach Out, Last Conversation, Last Method = "SMS/iMessage"
   - Upserts a "Reach out to X" To-Do task with context notes
5. Creates To-Do tasks for any overdue KIT contacts without one
6. Calls `imessage_export.main()` to produce the iMessage JSON export (see below)

**Dry-run mode:** `--dry-run` flag previews changes without writing to Notion.

**Phone matching:** Supports both phone numbers (last 10 digits, country-code-agnostic) and email-based Apple IDs via the iMessage Handle field.

---

### `imessage_export.py` — iMessage JSON Export
**Called by:** `kit_sync.py` at the end of each run (not standalone)  
**Output:** `~/Documents/imessages-export.json`

Exports recent iMessages from the 16 hardcoded KIT contacts in `KIT_CONTACTS` dict. For each contact, captures the last 20 messages from the past 7 days, including an `unread_count` (messages from them after your last reply).

> **Note:** The JSON file lives on the Mac at `~/Documents/imessages-export.json`. This path is NOT accessible from the Cowork sandbox — see DD8 for how the morning briefing uses this data instead.

---

### `gmail_sync.py` — Gmail → KIT Tracker
**Requires:** `NOTION_TOKEN`, `ANTHROPIC_API_KEY`; Google OAuth credentials at `~/Library/Scripts/gmail_credentials.json`

Fetches sent Gmail threads from the last 30 days. Matches recipients to KIT contacts by email address. For each match with a newer date: summarises the thread with Claude Haiku and updates Last Contact, Last Conversation, Last Method = "Email" in the KIT Tracker.

---

### `calendar_sync.py` — Google Calendar → KIT Tracker
**Requires:** `NOTION_TOKEN`, `ANTHROPIC_API_KEY`; same Google OAuth credentials as gmail_sync.py

Fetches Google Calendar events from the last 14 days. Matches attendees to KIT contacts by email or name (including "With: Name" in event descriptions). Updates Last Contact, Last Conversation, Last Method = "Calendar" for matched contacts.

---

### `deploy_kit_sync.command`
Double-click to deploy scripts from the workspace to `~/Library/Scripts/`. Deploys both `kit_sync.py` and `kit_helpers.py`, creates `.bak` backups of the previous versions, and verifies Python syntax before completing.

---

## Cowork Scheduled Tasks (~25 jobs)

All tasks run in the Cowork AI sandbox via the `mcp__scheduled-tasks__*` API. They have access to Notion, Gmail, and Calendar MCPs but **not** to the Mac filesystem.

### Morning Briefing
**Task ID:** `morning-briefing`  
**Schedule:** Daily ~6:38 AM (cron `38 6 * * *`)  
**Saves to:** Daily Command Center → `☀️ Morning Briefing — [Weekday], [Month] [Day]`

Five sections:
1. **Today's To-Dos** — tasks due today, grouped by SPIRE, organised into Focus / Quick Wins / Wellness / Articles / KIT
2. **SPIRE Overview** — last 7 days completed (ASCII bar chart) + next 7 days projected; flags zeroed dimensions
3. **Decisions Needed** — top 3–5 open loops from Gmail (unanswered questions > 48 hrs), Tasks (Waiting/High Priority), and KIT (overdue reach-outs)
4. **Draft Responses** — Gmail: saves actual drafts via create_draft; KIT: queries KIT Tracker for contacts with recent Last Contact or overdue Next Reach Out, suggests follow-up messages
5. **Communication Tone** — Gmail cadence analysis; KIT: SMS/iMessage contact frequency and drop-off detection (via Notion KIT Tracker)

> **Architecture note:** The briefing reads iMessage data from the KIT Tracker in Notion (not from a JSON file) because the sandbox can't access Mac filesystem paths (see DD8).

---

### Recurring Task Spawners
| Task ID | Schedule | Purpose |
|---------|----------|---------|
| `notion-recurring-daily` | 6:10 AM daily | Spawns daily recurring template tasks |
| `notion-recurring-weekly` | 6:08 AM Mondays | Spawns weekly recurring tasks |
| `notion-recurring-biweekly` | 6:08 AM Mondays | Spawns bi-weekly tasks |
| `notion-recurring-every-3-weeks` | 6:00 AM Mondays | Every-3-week tasks |
| `notion-recurring-every-4-weeks` | 6:02 AM Mondays | Every-4-week tasks |
| `notion-recurring-every-6-weeks` | 6:01 AM Mondays | Every-6-week tasks |
| `notion-recurring-monthly` | 6:00 AM on 1st | Monthly recurring tasks |
| `notion-recurring-quarterly` | 6:00 AM on Jan/Apr/Jul/Oct 1st | Quarterly recurring tasks |
| `notion-recurring-annually` | 6:00 AM on Jan 1st | Annual recurring tasks |

### Article / Media Management
| Task ID | Schedule | Purpose |
|---------|----------|---------|
| `feedly-inbox-to-media` | Every 15 min, 6am–10pm | Syncs Feedly Inbox Notion page → Media DB |
| `feedly-inbox-to-media-night` | Hourly, 10pm–6am | Same, lower frequency overnight |
| `media-link-extractor` | Every 2 hours | Extracts URLs from Media DB Name fields → Link field |
| `notion-articles-to-tasks` | 7:02 AM daily | Creates To-Do tasks for 5 newest + 5 oldest articles |
| `daily-backlog-articles` | 7:09 AM daily | Picks 5 unread articles for a reading digest |
| `notion-articles-sync-completion` | Hourly | When reading tasks are Done → marks Media DB entry as Finished |
| `reading-articles-to-todo` | Every 4 hours | Catch-up: creates To-Do for any reading article missing one |
| `media-cleanup-finished` | 5:04 AM Mondays | Copies Finished Media entries to Archive DB |

### Productivity & Dashboard
| Task ID | Schedule | Purpose |
|---------|----------|---------|
| `notion-dashboard-refresh` | 6:06 AM daily | Refreshes Task Dashboard metrics + SPIRE balance |
| `ifttt-task-enricher` | 7:18 AM + 8:15 PM | Adds SPIRE tags and Due Date to IFTTT-spawned tasks |

### KIT / Relationships
| Task ID | Schedule | Purpose |
|---------|----------|---------|
| `imessage-kit-sync` | 7:38 AM daily | Triggers Kit Sync shortcut → updates KIT Tracker from iMessage |
| `keep-in-touch-todo-sync` | 8:06 AM daily | Creates To-Do tasks for due KIT reach-outs |
| `kit-fill-blank-next-reach-out` | 8:12 AM daily | Auto-fills blank Next Reach Out dates |

### Reviews
| Task ID | Schedule | Purpose |
|---------|----------|---------|
| `calendar-spire-sync` | 7:02 AM Mondays | Classifies last 7 days of calendar events by SPIRE |
| `weekly-review` | 7:10 PM Saturdays | Full SPIRE-structured weekly review → saved to Notion |
| `quarterly-spire-review` | Jul 7 2026, 9 AM | Q3 2026 Quarterly SPIRE Review |

---

## Infrastructure

### Mac Mini (always-on)
- Must not sleep (DD1) — required for launchd and Shortcuts-triggered jobs
- `KitSyncRunner.app` lives at `~/Library/Scripts/KitSyncRunner.app/` — a compiled wrapper launched by the `com.richardcarroll.kit-sync` launchd job
- Launchd plist: `~/Library/LaunchAgents/com.richardcarroll.kit-sync.plist`
- Logs: `~/Library/Logs/kit-sync.log`
- Scripts deployed to: `~/Library/Scripts/` (kit_sync.py, kit_helpers.py, imessage_export.py, gmail_sync.py, calendar_sync.py)
- Google OAuth credentials: `~/Library/Scripts/gmail_credentials.json` + `gmail_token.json`

### Environment Variables (set in Shortcuts shell script)
```bash
export NOTION_TOKEN="ntn_..."
export NOTION_DATABASE_ID="64204e6b365f836c83798111f9c55f5a"
export ANTHROPIC_API_KEY="sk-ant-..."
python3 ~/Library/Scripts/kit_sync.py
```

### Launchd Plist (`com.richardcarroll.kit-sync.plist`)
Triggers `KitSyncRunner.app` daily at 5:45 AM. The plist sets `NOTION_TOKEN` only; `ANTHROPIC_API_KEY` and `NOTION_DATABASE_ID` are set in the Shortcuts shell script.

### Vercel
- Free tier hosting for the PWA
- Environment variables: `NOTION_TOKEN`, `NOTION_DATABASE_ID`
- Serverless functions in `api/`

---

## Design Decisions

| ID | Decision | Rationale |
|----|----------|-----------|
| DD1 | Mac Mini will not sleep | Ensures launchd jobs fire on schedule |
| DD2 | iMessage is primary contact method; Email and iMessage Handle fields for email-based Apple IDs | Most contacts reachable via iMessage; email + Apple ID covers the rest |
| DD3 | KIT meeting attendee review is manual (not automated) | Too context-dependent to automate reliably |
| DD4 | All KIT contacts included (not a filtered subset) | No value in maintaining a tiered list |
| DD5 | All 5 data sources used; 2-day threshold for unanswered emails | Balances sensitivity vs. noise for email follow-up detection |
| DD6 | Kit Sync runs via Shortcuts.app (not direct launchd Python call) | Shortcuts.app holds Full Disk Access; launchd subprocesses inherit it. Direct `python3` via launchd does not get FDA, so chat.db access fails. `KitSyncRunner.app` is launched by launchd and opens Shortcuts programmatically. |
| DD7 | SSL fix applied to all urllib calls: `ssl.create_default_context()` + `ctx.load_verify_locations("/etc/ssl/cert.pem")` | Python 3.14 framework builds on macOS don't bundle root CA certificates. Without this fix, all HTTPS calls (Notion API, Anthropic API) raise `CERTIFICATE_VERIFY_FAILED`. `/etc/ssl/cert.pem` is the macOS system keychain PEM bundle. |
| DD8 | Morning briefing reads iMessage data from KIT Tracker (Notion), not from `~/Documents/imessages-export.json` | Cowork scheduled tasks run in a cloud sandbox. `~/Documents/` in Bash resolves to the sandbox home, not the Mac's home directory. The JSON file produced by `imessage_export.py` is inaccessible from there. KIT Tracker holds the same data (Last Contact, Last Conversation) and is reachable via Notion MCP. Trade-off: unread message counts (people who texted you but haven't received a reply) are not captured in Notion — only outbound contacts appear. |
| DD9 | `imessage_export.py` is called from inside `kit_sync.py` rather than as a standalone launchd job | Both scripts need Full Disk Access and the same Shortcuts invocation. Bundling the export into kit_sync.py avoids a second Shortcuts trigger and keeps the iMessage data fresh at the same time as the KIT sync. |
| DD10 | `kit_helpers.py` as a shared utilities module | kit_sync, gmail_sync, and calendar_sync all need Notion API calls, Claude summarisation, and KIT record manipulation. Centralising in kit_helpers prevents drift and makes SSL fixes apply everywhere. |
| DD11 | Claude Haiku (not Sonnet/Opus) for conversation summarisation | Summaries are 1–2 sentences of factual recall. Haiku is fast, cheap, and sufficient; Sonnet would be overkill at ~20× the cost per token. |

---

## Changelog

### Phase 10 (May 2026) — v2.2.x

**Article move-to feature (v2.2.0):**
- `api/move-article.js` added — POST endpoint to move an article task to To Visit, To Buy, or Future Projects in Notion
- `api/move-task.js` added — POST endpoint to move a regular To-Do task to To Buy or To Visit
- `api/health.js`, `api/stats.js`, `api/transcode.js` added — health nudge banner, completion stats, transcode pipeline status
- `scan.html` added — barcode scanner UI for logging books and vinyl
- `api/log-media.js`, `api/lookup-barcode.js` added — barcode lookup and media logging
- `vercel.json` updated to register all new serverless functions
- UI: ↗ move button on article cards; destination picker modal (To Visit / To Buy / Future Projects)
- UI: ↪ move button on task cards; two-option modal (To Buy / To Visit)
- UI: KIT badge in header, scan icon link, health nudge banner
- `TO_BUY_DB_ID` and `TO_VISIT_DB_ID` Vercel env vars added (May 18)
- Merge conflict with remote resolved — both move-task and move-article implementations kept intact

**Bug fixes (v2.2.1):**
- Error toast now shows actual Notion API error message instead of generic "something went wrong"
- README.md expanded: full API endpoint table (12 endpoints), complete file structure listing

**Versioning standard adopted:** SemVer — PATCH for fixes/docs, MINOR for new features, MAJOR for redesigns.

---

### Phase 9 (April 2026)

**Kit Sync — major expansion:**
- `kit_helpers.py` added as a shared utilities module (SSL fix, Notion API, Claude summarisation, To-Do helpers)
- `imessage_export.py` added — exports recent iMessages for the 16 hardcoded KIT contacts to `~/Documents/imessages-export.json`; called automatically at the end of each Kit Sync run
- `gmail_sync.py` added — syncs Gmail sent threads to KIT Tracker via Google OAuth
- `calendar_sync.py` added — syncs Google Calendar attendees to KIT Tracker via Google OAuth
- Claude Haiku summarisation added to all three sync scripts — populates "Last Conversation" in KIT Tracker
- "Last Method of Contact" field now updated automatically (SMS/iMessage / Email / Calendar)
- To-Do creation for overdue KIT contacts: Kit Sync now upserts "Reach out to X" tasks with context notes
- **SSL fix (DD7):** `_ssl_ctx()` added to kit_helpers.py — resolves `CERTIFICATE_VERIFY_FAILED` for Python 3.14 on macOS
- `deploy_kit_sync.command` updated to deploy both `kit_sync.py` and `kit_helpers.py` (previously kit_sync.py only)
- KIT Tracker DB ID corrected to `44f5fdf6-c4b5-42ed-a97b-5a667ffebd13`

**Cowork Scheduled Tasks — full suite launched:**
- ~25 scheduled tasks now running covering recurring task spawning, article management, KIT sync, dashboard refresh, and reviews
- `morning-briefing` task: daily briefing saved to Daily Command Center → covers To-Dos, SPIRE balance, decisions needed, Gmail drafts, KIT follow-up suggestions, and communication tone analysis
- Morning briefing updated to read iMessage data from KIT Tracker in Notion (not JSON file) — see DD8

**Design decisions DD6–DD11 confirmed** (see table above)

---

### Phase 8 (earlier 2026)

- **Calendar SPIRE Sync:** Dedicated `calendar-spire-sync` scheduled task; events stored in Notion Calendar SPIRE Log DB.
- **SPIRE definition corrected:** E = Emotional.
- **KIT Tracker:** Email + Phone fields added; 13 contacts Phone-populated, 4 Email-populated.
- **iMessage → KIT Sync automation first introduced:** `kit_sync.py` + launchd plist.
- **Design decisions DD1–DD5 confirmed.**

---

*Last updated: May 2026 — Phase 10*
