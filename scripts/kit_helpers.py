#!/usr/bin/env python3
"""
kit_helpers.py — Shared utilities for KIT Tracker sync scripts.
Used by kit_sync.py, gmail_sync.py, and calendar_sync.py.
"""

import json
import re
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Optional

NOTION_VERSION = "2022-06-28"
KIT_DB_ID = "44f5fdf6-c4b5-42ed-a97b-5a667ffebd13"

TODO_DB_ID_ENV = "NOTION_DATABASE_ID"  # env var name for To-Do database

REACH_OUT_DAYS = {
    "Weekly": 7,
    "Fortnightly": 14,
    "Monthly": 30,
    "Every 2 Months": 60,
    "Every 3 Months": 90,
    "Every 4 Weeks": 28,
    "Every 6 Months": 180,
    "Yearly": 365,
}

# ─── Phone normalisation ────────────────────────────────────────────────────

def normalise_phone(phone_str: str) -> str:
    """Strip to last 10 digits for country-code-agnostic matching."""
    if not phone_str:
        return ""
    digits = re.sub(r"\D", "", phone_str)
    return digits[-10:] if len(digits) >= 10 else digits


# ─── Date helpers ────────────────────────────────────────────────────────────

def reach_out_every_to_days(reach_out_every_str: Optional[str]) -> Optional[int]:
    """Convert 'Monthly', '1 week', etc. to number of days, or None."""
    if not reach_out_every_str:
        return None
    return REACH_OUT_DAYS.get(reach_out_every_str)


def compute_next_reach_out(
    last_contact_date: datetime, reach_out_every: Optional[str]
) -> Optional[datetime]:
    """Returns the next reach-out date or None if interval unknown."""
    days = reach_out_every_to_days(reach_out_every)
    if days is None:
        return None
    return (last_contact_date + timedelta(days=days)).replace(
        hour=0, minute=0, second=0, microsecond=0
    )


def parse_notion_date(prop: Optional[dict]) -> Optional[datetime]:
    if not prop:
        return None
    d = prop.get("date")
    if not d or not d.get("start"):
        return None
    s = d["start"]
    if "T" in s:
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    return datetime.strptime(s, "%Y-%m-%d").replace(tzinfo=timezone.utc)


# ─── Notion API ──────────────────────────────────────────────────────────────

def notion_request(
    method: str, path: str, body: Optional[dict], token: str
) -> dict:
    url = f"https://api.notion.com/v1{path}"
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Notion-Version": NOTION_VERSION,
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())


def get_kit_records(notion_token: str) -> list:
    """Fetch all KIT pages from Notion, handling pagination."""
    pages = []
    cursor = None
    while True:
        body: dict = {"page_size": 100}
        if cursor:
            body["start_cursor"] = cursor
        resp = notion_request("POST", f"/databases/{KIT_DB_ID}/query", body, notion_token)
        pages.extend(resp["results"])
        if not resp.get("has_more"):
            break
        cursor = resp["next_cursor"]
    return pages


def extract_kit_fields(page: dict) -> dict:
    """Parse a raw Notion KIT page into a flat dict of useful fields."""
    props = page["properties"]

    def rich_text_value(key: str) -> str:
        p = props.get(key, {})
        t = p.get("title") or p.get("rich_text") or []
        return "".join(item["plain_text"] for item in t)

    def select_value(key: str) -> Optional[str]:
        p = props.get(key, {})
        sel = p.get("select")
        return sel["name"] if sel else None

    return {
        "id": page["id"],
        "name": rich_text_value("Name"),
        "phone": (props.get("Phone") or {}).get("phone_number") or "",
        "email": rich_text_value("Email"),
        "last_contact": parse_notion_date(props.get("Last Contact")),
        "reach_out_every": select_value("Reach Out Every"),
        "last_method": select_value("Last Method of Contact"),
        "last_conversation": rich_text_value("Last Conversation"),
    }


def update_kit_record(
    notion_token: str,
    page_id: str,
    updates: dict,
) -> None:
    """
    PATCH a KIT Notion page. Supported keys in updates:
      - last_contact: datetime
      - next_reach_out: datetime
      - last_conversation: str
      - last_method: str  (select value)
    """
    props: dict = {}

    if "last_contact" in updates:
        dt: datetime = updates["last_contact"]
        props["Last Contact"] = {"date": {"start": dt.strftime("%Y-%m-%d")}}

    if "next_reach_out" in updates:
        dt = updates["next_reach_out"]
        if dt is not None:
            props["Next Reach Out"] = {"date": {"start": dt.strftime("%Y-%m-%d")}}

    if "last_conversation" in updates:
        text = updates["last_conversation"]
        props["Last Conversation"] = {
            "rich_text": [{"type": "text", "text": {"content": text[:2000]}}]
        }

    if "last_method" in updates:
        method = updates["last_method"]
        if method:
            props["Last Method of Contact"] = {"select": {"name": method}}

    if props:
        notion_request("PATCH", f"/pages/{page_id}", {"properties": props}, notion_token)


# ─── Claude summarisation ────────────────────────────────────────────────────

def summarise_with_claude(
    anthropic_key: str,
    contact_name: str,
    thread_text: str,
    source_type: str,  # "iMessage", "Gmail", or "Calendar"
) -> str:
    """
    Call claude-haiku-4-5-20251001 to summarise a conversation thread.
    Returns a 1–2 sentence plain-text summary.
    """
    if not thread_text.strip():
        return ""

    prompt = (
        f"You are summarising a {source_type} conversation between the user and {contact_name}. "
        f"Write 1–2 sentences describing what was discussed or the nature of the interaction. "
        f"Be specific and concrete. Do not use bullet points. Do not say 'the user'.\n\n"
        f"Conversation:\n{thread_text[:8000]}"
    )

    body = {
        "model": "claude-haiku-4-5-20251001",
        "max_tokens": 150,
        "messages": [{"role": "user", "content": prompt}],
    }

    data = json.dumps(body).encode()
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=data,
        method="POST",
        headers={
            "x-api-key": anthropic_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
    )
    with urllib.request.urlopen(req) as resp:
        result = json.loads(resp.read())

    return result["content"][0]["text"].strip()


# ─── To-Do task helpers ──────────────────────────────────────────────────────

def format_kit_todo_notes(
    last_contact_date: datetime,
    summary: str,
    last_method: str,
) -> str:
    """Format the To-Do notes field for a KIT reach-out task."""
    date_str = last_contact_date.strftime("%Y-%m-%d")
    method = last_method or "message"
    if summary:
        return f"Last spoke {date_str}. Context: {summary}.\nReach out via {method}."
    return f"Last spoke {date_str}.\nReach out via {method}."


def find_existing_kit_todo(
    notion_token: str,
    todo_db_id: str,
    contact_name: str,
) -> Optional[str]:
    """
    Search To-Do DB for an existing 'Reach out to <name>' task.
    Returns the page_id if found, or None.
    """
    title = f"Reach out to {contact_name}"
    body = {
        "filter": {
            "property": "Task",
            "title": {"equals": title},
        },
        "page_size": 1,
    }
    try:
        resp = notion_request("POST", f"/databases/{todo_db_id}/query", body, notion_token)
        results = resp.get("results", [])
        if results:
            return results[0]["id"]
    except Exception:
        pass
    return None


def create_kit_todo(
    notion_token: str,
    todo_db_id: str,
    contact_name: str,
    notes: str,
    due_date: Optional[datetime] = None,
) -> Optional[str]:
    """
    Create a To-Do task: 'Reach out to <contact_name>' with SPIRE=Relational.
    Returns the new page_id on success, or None.
    """
    title = f"Reach out to {contact_name}"
    props: dict = {
        "Task": {"title": [{"type": "text", "text": {"content": title}}]},
        "SPIRE": {"multi_select": [{"name": "Relational"}]},
    }
    if notes:
        props["Notes"] = {
            "rich_text": [{"type": "text", "text": {"content": notes[:2000]}}]
        }
    if due_date:
        props["Due"] = {"date": {"start": due_date.strftime("%Y-%m-%d")}}

    try:
        resp = notion_request(
            "POST",
            "/pages",
            {"parent": {"database_id": todo_db_id}, "properties": props},
            notion_token,
        )
        return resp["id"]
    except Exception:
        return None


def upsert_kit_todo(
    notion_token: str,
    todo_db_id: str,
    contact_name: str,
    notes: str,
    due_date: Optional[datetime] = None,
) -> tuple:
    """
    Find existing reach-out To-Do or create a new one. Updates notes if found.
    Returns (page_id, created: bool).
    """
    existing_id = find_existing_kit_todo(notion_token, todo_db_id, contact_name)
    if existing_id:
        # Update notes on existing task
        props: dict = {}
        if notes:
            props["Notes"] = {
                "rich_text": [{"type": "text", "text": {"content": notes[:2000]}}]
            }
        if due_date:
            props["Due"] = {"date": {"start": due_date.strftime("%Y-%m-%d")}}
        if props:
            notion_request("PATCH", f"/pages/{existing_id}", {"properties": props}, notion_token)
        return existing_id, False
    else:
        new_id = create_kit_todo(notion_token, todo_db_id, contact_name, notes, due_date)
        return new_id, True
