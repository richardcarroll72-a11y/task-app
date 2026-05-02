#!/usr/bin/env python3
"""
calendar_sync.py — Syncs Google Calendar events to Notion KIT Tracker.

Fetches events from the last 14 days, matches attendees to KIT contacts
by email or name (including 'With:' in event descriptions), and updates
Last Contact + Last Conversation fields.

Usage:
    calendar_sync.py [--dry-run]

Requires env vars:
    NOTION_TOKEN        — Notion integration token
    ANTHROPIC_API_KEY   — Anthropic API key
    NOTION_DATABASE_ID  — (optional) To-Do database ID

OAuth credentials (shared with gmail_sync.py):
    ~/Library/Scripts/gmail_credentials.json  — Google OAuth client credentials
    ~/Library/Scripts/gmail_token.json        — Cached OAuth token (auto-created)
"""

import argparse
import logging
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from typing import Optional

sys.path.insert(0, os.path.dirname(__file__))
import kit_helpers as kh

# ─── Config ──────────────────────────────────────────────────────────────────

NOTION_TOKEN = os.environ["NOTION_TOKEN"]
ANTHROPIC_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
TODO_DB_ID = os.environ.get("NOTION_DATABASE_ID", "")
LOOKBACK_DAYS = 14

CREDENTIALS_PATH = os.path.expanduser("~/Library/Scripts/gmail_credentials.json")
TOKEN_PATH = os.path.expanduser("~/Library/Scripts/gmail_token.json")
LOG_PATH = os.path.expanduser("~/Library/Logs/kit-calendar-sync.log")

SCOPES = [
    "https://www.googleapis.com/auth/calendar.readonly",
]

# ─── Logging ─────────────────────────────────────────────────────────────────

os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
logging.basicConfig(
    level=logging.INFO,
    format="[calendar_sync] %(asctime)s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    handlers=[
        logging.FileHandler(LOG_PATH),
        logging.StreamHandler(sys.stdout),
    ],
)
log = logging.getLogger(__name__)


# ─── Google OAuth ─────────────────────────────────────────────────────────────

def get_calendar_service():
    """Authenticate and return a Google Calendar API service object."""
    try:
        from google.auth.transport.requests import Request
        from google.oauth2.credentials import Credentials
        from google_auth_oauthlib.flow import InstalledAppFlow
        from googleapiclient.discovery import build
    except ImportError:
        log.error(
            "Google API libraries not installed. Run:\n"
            "  pip3 install --break-system-packages google-auth google-auth-oauthlib google-auth-httplib2 google-api-python-client"
        )
        sys.exit(1)

    # Load existing token (may have multiple scopes; we only need calendar.readonly here,
    # but if gmail_sync.py has already authenticated with a broader token, reuse it)
    creds = None
    if os.path.exists(TOKEN_PATH):
        from google.oauth2.credentials import Credentials as Creds
        creds = Creds.from_authorized_user_file(TOKEN_PATH, SCOPES)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            if not os.path.exists(CREDENTIALS_PATH):
                log.error(f"Credentials not found at {CREDENTIALS_PATH}")
                sys.exit(1)
            flow = InstalledAppFlow.from_client_secrets_file(CREDENTIALS_PATH, SCOPES)
            creds = flow.run_local_server(port=0)

        with open(TOKEN_PATH, "w") as f:
            f.write(creds.to_json())

    return build("calendar", "v3", credentials=creds)


# ─── Calendar helpers ─────────────────────────────────────────────────────────

def parse_with_names(text: str) -> list:
    """
    Extract names from 'With: Name1, Name2' in event description/notes.
    Returns list of stripped name strings.
    """
    if not text:
        return []
    match = re.search(r"[Ww]ith:\s*(.+?)(?:\n|$)", text)
    if not match:
        return []
    raw = match.group(1)
    return [n.strip() for n in raw.split(",") if n.strip()]


def name_matches(kit_name: str, candidate: str) -> bool:
    """
    Fuzzy name match: True if candidate contains any word from kit_name
    (case-insensitive, 4+ chars).
    """
    kit_words = [w for w in kit_name.lower().split() if len(w) >= 4]
    candidate_lower = candidate.lower()
    return any(w in candidate_lower for w in kit_words)


def detect_method(event: dict) -> str:
    """
    Return 'Video Call' if a Meet/Zoom/Teams link is present, else 'In Person'.
    """
    desc = (event.get("description") or "").lower()
    location = (event.get("location") or "").lower()
    conf_data = event.get("conferenceData", {})

    video_keywords = ["meet.google.com", "zoom.us", "teams.microsoft.com", "whereby.com"]
    for kw in video_keywords:
        if kw in desc or kw in location:
            return "Video Call"

    if conf_data.get("entryPoints"):
        return "Video Call"

    return "In Person"


def get_event_datetime(event: dict) -> Optional[datetime]:
    """Return the event start as a timezone-aware datetime."""
    start = event.get("start", {})
    dt_str = start.get("dateTime") or start.get("date")
    if not dt_str:
        return None
    if "T" in dt_str:
        dt = datetime.fromisoformat(dt_str)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    return datetime.strptime(dt_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)


def get_events(service, lookback_days: int) -> list:
    """Fetch all calendar events from the last lookback_days days."""
    now = datetime.now(timezone.utc)
    time_min = (now - timedelta(days=lookback_days)).isoformat()
    time_max = now.isoformat()

    events = []
    page_token = None
    while True:
        kwargs = dict(
            calendarId="primary",
            timeMin=time_min,
            timeMax=time_max,
            singleEvents=True,
            orderBy="startTime",
            maxResults=250,
        )
        if page_token:
            kwargs["pageToken"] = page_token
        resp = service.events().list(**kwargs).execute()
        events.extend(resp.get("items", []))
        page_token = resp.get("nextPageToken")
        if not page_token:
            break

    return events


# ─── Main ────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    dry_run = args.dry_run

    mode = "[dry-run] " if dry_run else ""
    log.info(f"{mode}Starting Calendar → KIT sync")

    if not ANTHROPIC_KEY:
        log.warning("ANTHROPIC_API_KEY not set — summaries will be skipped")

    service = get_calendar_service()
    log.info("Calendar authenticated")

    kit_pages = kh.get_kit_records(NOTION_TOKEN)
    kit_fields_list = [kh.extract_kit_fields(p) for p in kit_pages]
    log.info(f"{len(kit_fields_list)} KIT records loaded")

    # Build lookup indices
    email_to_kit: dict = {}
    for fields in kit_fields_list:
        email = (fields.get("email") or "").strip().lower()
        if email:
            email_to_kit[email] = fields

    events = get_events(service, LOOKBACK_DAYS)
    log.info(f"{len(events)} calendar events in last {LOOKBACK_DAYS} days")

    # Track which KIT records were updated (to avoid double-updates per run)
    updated_ids: set = set()
    updated = 0

    for event in events:
        # Skip cancelled events
        if event.get("status") == "cancelled":
            continue

        event_dt = get_event_datetime(event)
        if not event_dt:
            continue

        event_title = event.get("summary", "")
        event_desc = event.get("description") or ""
        attendees = event.get("attendees", [])
        self_email = None

        # Find self in attendees to confirm attendance
        for att in attendees:
            if att.get("self"):
                self_email = att.get("email", "").lower()
                # Skip if declined
                if att.get("responseStatus") == "declined":
                    break
        else:
            pass  # no self entry found; treat as attended

        method = detect_method(event)

        # Build candidate matches: (kit_fields, match_reason)
        matches: list = []

        # 1. Match by attendee email
        for att in attendees:
            if att.get("self"):
                continue
            att_email = att.get("email", "").lower()
            if att_email in email_to_kit:
                fields = email_to_kit[att_email]
                if fields["id"] not in updated_ids:
                    matches.append((fields, f"attendee email: {att_email}"))

        # 2. Match by attendee display name
        for att in attendees:
            if att.get("self"):
                continue
            disp = att.get("displayName", "")
            for fields in kit_fields_list:
                if fields["id"] in updated_ids:
                    continue
                if fields["name"] and name_matches(fields["name"], disp):
                    # Don't duplicate an email match
                    already = any(f["id"] == fields["id"] for f, _ in matches)
                    if not already:
                        matches.append((fields, f"attendee name: {disp}"))

        # 3. Match by 'With: Name' in description
        with_names = parse_with_names(event_desc)
        for wname in with_names:
            for fields in kit_fields_list:
                if fields["id"] in updated_ids:
                    continue
                if fields["name"] and name_matches(fields["name"], wname):
                    already = any(f["id"] == fields["id"] for f, _ in matches)
                    if not already:
                        matches.append((fields, f"'With:' description: {wname}"))

        # 4. Match by event title (last resort)
        if not matches:
            for fields in kit_fields_list:
                if fields["id"] in updated_ids:
                    continue
                if fields["name"] and name_matches(fields["name"], event_title):
                    matches.append((fields, f"event title: {event_title}"))

        if not matches:
            continue

        for fields, reason in matches:
            old_last_contact = fields["last_contact"]

            if old_last_contact and event_dt.date() <= old_last_contact.date():
                continue

            if dry_run:
                log.info(
                    f"[dry-run] Would update: {fields['name']}"
                    f" | Event: '{event_title}'"
                    f" | {event_dt.strftime('%Y-%m-%d')}"
                    f" | {method}"
                    f" | Matched via {reason}"
                )
                continue

            # Build event context for summarisation
            event_context = f"Event: {event_title} on {event_dt.strftime('%Y-%m-%d')}"
            if event_desc:
                event_context += f"\nDescription: {event_desc[:500]}"

            summary = ""
            if ANTHROPIC_KEY:
                try:
                    summary = kh.summarise_with_claude(
                        ANTHROPIC_KEY, fields["name"], event_context, "Calendar"
                    )
                except Exception as e:
                    log.warning(f"Summarisation failed for {fields['name']}: {e}")

            next_reach_out = kh.compute_next_reach_out(event_dt, fields["reach_out_every"])

            kit_updates = {
                "last_contact": event_dt,
                "last_method": method,
            }
            if next_reach_out:
                kit_updates["next_reach_out"] = next_reach_out

            existing_convo = fields.get("last_conversation", "")
            if summary and (not existing_convo or old_last_contact is None or
                            event_dt.date() > old_last_contact.date()):
                kit_updates["last_conversation"] = summary

            kh.update_kit_record(NOTION_TOKEN, fields["id"], kit_updates)
            updated_ids.add(fields["id"])

            if TODO_DB_ID and summary:
                notes = kh.format_kit_todo_notes(event_dt, summary, method)
                kh.upsert_kit_todo(NOTION_TOKEN, TODO_DB_ID, fields["name"], notes, next_reach_out)

            summ_str = f" | {summary[:60]}…" if summary else ""
            log.info(
                f"Updated: {fields['name']}"
                f" | '{event_title}'"
                f" | {event_dt.strftime('%Y-%m-%d')}"
                f" | {method}{summ_str}"
            )
            # Update in-memory
            fields["last_contact"] = event_dt
            updated += 1

    log.info(f"Done — {updated} KIT record(s) updated")


if __name__ == "__main__":
    main()
