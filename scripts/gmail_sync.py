#!/usr/bin/env python3
"""
gmail_sync.py — Syncs Gmail sent threads to Notion KIT Tracker.

Fetches sent email threads from the last 30 days, matches recipients
to KIT contacts by email, and updates Last Contact + Last Conversation
fields via Claude Haiku summarisation.

Usage:
    gmail_sync.py [--dry-run]

Requires env vars:
    NOTION_TOKEN        — Notion integration token
    ANTHROPIC_API_KEY   — Anthropic API key
    NOTION_DATABASE_ID  — (optional) To-Do database ID

OAuth credentials:
    ~/Library/Scripts/gmail_credentials.json  — Google OAuth client credentials
    ~/Library/Scripts/gmail_token.json        — Cached OAuth token (auto-created)
"""

import argparse
import base64
import json
import logging
import os
import sys
from datetime import datetime, timedelta, timezone
from typing import Optional

# Add scripts directory to path for kit_helpers
sys.path.insert(0, os.path.dirname(__file__))
import kit_helpers as kh

# ─── Config ──────────────────────────────────────────────────────────────────

NOTION_TOKEN = os.environ["NOTION_TOKEN"]
ANTHROPIC_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
TODO_DB_ID = os.environ.get("NOTION_DATABASE_ID", "")
LOOKBACK_DAYS = 30

CREDENTIALS_PATH = os.path.expanduser("~/Library/Scripts/gmail_credentials.json")
TOKEN_PATH = os.path.expanduser("~/Library/Scripts/gmail_token.json")
LOG_PATH = os.path.expanduser("~/Library/Logs/kit-gmail-sync.log")

SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
]

# ─── Logging ─────────────────────────────────────────────────────────────────

os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
logging.basicConfig(
    level=logging.INFO,
    format="[gmail_sync] %(asctime)s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    handlers=[
        logging.FileHandler(LOG_PATH),
        logging.StreamHandler(sys.stdout),
    ],
)
log = logging.getLogger(__name__)


# ─── Google OAuth ─────────────────────────────────────────────────────────────

def get_gmail_service():
    """Authenticate and return a Gmail API service object."""
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

    creds = None
    if os.path.exists(TOKEN_PATH):
        creds = Credentials.from_authorized_user_file(TOKEN_PATH, SCOPES)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            if not os.path.exists(CREDENTIALS_PATH):
                log.error(f"Gmail credentials not found at {CREDENTIALS_PATH}")
                log.error(
                    "Set up a Google Cloud project, enable the Gmail API,\n"
                    "create OAuth 2.0 credentials (Desktop app type), and\n"
                    f"download the JSON to {CREDENTIALS_PATH}"
                )
                sys.exit(1)
            flow = InstalledAppFlow.from_client_secrets_file(CREDENTIALS_PATH, SCOPES)
            creds = flow.run_local_server(port=0)

        with open(TOKEN_PATH, "w") as f:
            f.write(creds.to_json())

    return build("gmail", "v1", credentials=creds)


# ─── Gmail helpers ────────────────────────────────────────────────────────────

def extract_email_address(addr: str) -> str:
    """Extract 'user@example.com' from 'Name <user@example.com>' or plain address."""
    if "<" in addr and ">" in addr:
        return addr[addr.index("<") + 1 : addr.index(">")].strip().lower()
    return addr.strip().lower()


def get_sent_threads(service, lookback_days: int) -> list:
    """Fetch sent threads from last lookback_days days. Returns list of thread dicts."""
    after_ts = int((datetime.now(timezone.utc) - timedelta(days=lookback_days)).timestamp())
    query = f"in:sent after:{after_ts}"

    threads = []
    page_token = None
    while True:
        kwargs = {"userId": "me", "q": query, "maxResults": 100}
        if page_token:
            kwargs["pageToken"] = page_token
        resp = service.users().threads().list(**kwargs).execute()
        threads.extend(resp.get("threads", []))
        page_token = resp.get("nextPageToken")
        if not page_token:
            break

    return threads


def get_thread_messages(service, thread_id: str) -> list:
    """Fetch all messages in a thread. Returns list of message metadata dicts."""
    thread = service.users().threads().get(
        userId="me", id=thread_id, format="metadata",
        metadataHeaders=["From", "To", "Cc", "Subject", "Date"]
    ).execute()
    return thread.get("messages", [])


def get_thread_body(service, thread_id: str) -> str:
    """Fetch message bodies for a thread and return as plain text transcript."""
    thread = service.users().threads().get(
        userId="me", id=thread_id, format="full"
    ).execute()

    lines = []
    for msg in thread.get("messages", []):
        headers = {h["name"]: h["value"] for h in msg["payload"].get("headers", [])}
        sender = headers.get("From", "Unknown")
        date_str = headers.get("Date", "")
        subject = headers.get("Subject", "")

        # Extract plain text body
        body = _extract_body(msg["payload"])
        if body:
            lines.append(f"[{date_str}] From: {sender} | Subject: {subject}")
            lines.append(body[:500])  # cap per-message length
            lines.append("")

    return "\n".join(lines)


def _extract_body(payload: dict) -> str:
    """Recursively extract plain text from a Gmail message payload."""
    if payload.get("mimeType") == "text/plain":
        data = payload.get("body", {}).get("data", "")
        if data:
            return base64.urlsafe_b64decode(data + "==").decode("utf-8", errors="replace").strip()
    for part in payload.get("parts", []):
        text = _extract_body(part)
        if text:
            return text
    return ""


def get_thread_recipients(messages: list) -> set:
    """Return set of normalised email addresses from To/Cc fields of all messages."""
    recipients = set()
    for msg in messages:
        headers = {h["name"]: h["value"] for h in msg["payload"].get("headers", [])}
        for field in ("To", "Cc"):
            val = headers.get(field, "")
            for addr in val.split(","):
                addr = addr.strip()
                if addr:
                    recipients.add(extract_email_address(addr))
    return recipients


def get_thread_latest_date(messages: list) -> Optional[datetime]:
    """Return the latest message date in a thread."""
    latest = None
    for msg in messages:
        ts_ms = int(msg.get("internalDate", 0))
        if ts_ms:
            dt = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc)
            if latest is None or dt > latest:
                latest = dt
    return latest


# ─── Main ────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    dry_run = args.dry_run

    mode = "[dry-run] " if dry_run else ""
    log.info(f"{mode}Starting Gmail → KIT sync")

    if not ANTHROPIC_KEY:
        log.warning("ANTHROPIC_API_KEY not set — summaries will be skipped")

    service = get_gmail_service()
    log.info("Gmail authenticated")

    kit_pages = kh.get_kit_records(NOTION_TOKEN)
    kit_fields_list = [kh.extract_kit_fields(p) for p in kit_pages]
    log.info(f"{len(kit_fields_list)} KIT records loaded")

    # Build email → KIT record index
    email_to_kit: dict = {}
    for fields in kit_fields_list:
        email = (fields.get("email") or "").strip().lower()
        if email:
            email_to_kit[email] = fields

    if not email_to_kit:
        log.warning("No KIT records have Email populated — no matches possible")

    threads = get_sent_threads(service, LOOKBACK_DAYS)
    log.info(f"{len(threads)} sent threads in last {LOOKBACK_DAYS} days")

    updated = 0
    for thread in threads:
        thread_id = thread["id"]
        try:
            messages = get_thread_messages(service, thread_id)
        except Exception as e:
            log.warning(f"Failed to fetch thread {thread_id}: {e}")
            continue

        recipients = get_thread_recipients(messages)
        thread_date = get_thread_latest_date(messages)
        if not thread_date:
            continue

        for email in recipients:
            if email not in email_to_kit:
                continue

            fields = email_to_kit[email]
            old_last_contact = fields["last_contact"]

            # Only update if this thread is newer than stored Last Contact
            if old_last_contact and thread_date.date() <= old_last_contact.date():
                continue

            if dry_run:
                log.info(f"[dry-run] Would update: {fields['name']} (email: {email}) | {thread_date.strftime('%Y-%m-%d')}")
                continue

            # Get thread body for summarisation
            summary = ""
            if ANTHROPIC_KEY:
                try:
                    body_text = get_thread_body(service, thread_id)
                    if body_text:
                        summary = kh.summarise_with_claude(
                            ANTHROPIC_KEY, fields["name"], body_text, "Gmail"
                        )
                except Exception as e:
                    log.warning(f"Summarisation failed for {fields['name']}: {e}")

            next_reach_out = kh.compute_next_reach_out(thread_date, fields["reach_out_every"])

            kit_updates = {
                "last_contact": thread_date,
                "last_method": "Email",
            }
            if next_reach_out:
                kit_updates["next_reach_out"] = next_reach_out

            # Only write Last Conversation if empty or this is newer
            existing_convo = fields.get("last_conversation", "")
            if summary and (not existing_convo or old_last_contact is None or
                            thread_date.date() > old_last_contact.date()):
                kit_updates["last_conversation"] = summary

            kh.update_kit_record(NOTION_TOKEN, fields["id"], kit_updates)

            if TODO_DB_ID and summary:
                notes = kh.format_kit_todo_notes(thread_date, summary, "Email")
                kh.upsert_kit_todo(NOTION_TOKEN, TODO_DB_ID, fields["name"], notes, next_reach_out)

            summ_str = f" | {summary[:60]}…" if summary else ""
            log.info(
                f"Updated: {fields['name']} | {thread_date.strftime('%Y-%m-%d')}"
                f" | Email{summ_str}"
            )
            updated += 1
            # Update in-memory so we don't double-update same contact
            fields["last_contact"] = thread_date

    log.info(f"Done — {updated} KIT record(s) updated")


if __name__ == "__main__":
    main()
