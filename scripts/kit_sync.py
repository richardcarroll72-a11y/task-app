#!/usr/bin/env python3
"""
kit_sync.py — Syncs iMessage Last Contact dates to Notion Keep In Touch Tracker.

Reads sent messages from chat.db for the last 30 days, matches phone numbers
to KIT records in Notion, and updates Last Contact + Next Reach Out fields.
"""

import json
import os
import re
import shutil
import sqlite3
import tempfile
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Optional

# --- Config ---
CHAT_DB = os.path.expanduser("~/Library/Messages/chat.db")
NOTION_TOKEN = os.environ["NOTION_TOKEN"]
KIT_DB_ID = "44f5fdf6-c4b5-42ed-a97b-5a667ffebd13"
NOTION_VERSION = "2022-06-28"
LOOKBACK_DAYS = 30

REACH_OUT_DAYS = {
    "Weekly": 7,
    "Fortnightly": 14,
    "Monthly": 30,
    "Every 2 Months": 60,
    "Every 3 Months": 90,
    "Every 6 Months": 180,
    "Yearly": 365,
}

# iMessage stores dates as nanoseconds since 2001-01-01 UTC
MAC_EPOCH = 978307200  # Unix timestamp for 2001-01-01 00:00:00 UTC


def normalize_phone(phone: str) -> str:
    """Strip to digits, return last 10 digits for country-code-agnostic matching."""
    digits = re.sub(r"\D", "", phone)
    return digits[-10:] if len(digits) >= 10 else digits


def mac_ns_to_datetime(ts: int) -> datetime:
    unix_ts = ts / 1e9 + MAC_EPOCH
    return datetime.fromtimestamp(unix_ts, tz=timezone.utc)


def get_sent_contacts(lookback_days: int) -> dict:
    """
    Returns {normalized_phone: latest_sent_datetime} for contacts I messaged
    in the last lookback_days days.

    Copies chat.db to a temp file first to avoid locking the live database.
    """
    tmp = tempfile.mktemp(suffix=".db")
    shutil.copy2(CHAT_DB, tmp)
    try:
        conn = sqlite3.connect(tmp)
        conn.row_factory = sqlite3.Row

        cutoff_unix = (datetime.now(timezone.utc) - timedelta(days=lookback_days)).timestamp()
        cutoff_mac_ns = int((cutoff_unix - MAC_EPOCH) * 1e9)

        # Join through chat to get the recipient handles for sent messages.
        # This correctly handles group chats — any chat the sent message is in
        # counts as a "contact" for that message.
        query = """
            SELECT h.id AS phone, MAX(m.date) AS last_date
            FROM message m
            JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
            JOIN chat_handle_join chj ON chj.chat_id = cmj.chat_id
            JOIN handle h ON h.ROWID = chj.handle_id
            WHERE m.is_from_me = 1
              AND m.date > ?
            GROUP BY h.id
        """

        results: dict = {}
        for row in conn.execute(query, (cutoff_mac_ns,)):
            phone = row["phone"]
            if "@" in phone:  # skip iMessage addresses that are email-based Apple IDs
                continue
            norm = normalize_phone(phone)
            if not norm:
                continue
            dt = mac_ns_to_datetime(row["last_date"])
            if norm not in results or dt > results[norm]:
                results[norm] = dt

        conn.close()
        return results
    finally:
        os.unlink(tmp)


def notion_request(method: str, path: str, body: Optional[dict] = None) -> dict:
    url = f"https://api.notion.com/v1{path}"
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {NOTION_TOKEN}",
            "Notion-Version": NOTION_VERSION,
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())


def get_kit_records() -> list:
    """Fetch all KIT pages from Notion, handling pagination."""
    pages = []
    cursor = None
    while True:
        body: dict = {"page_size": 100}
        if cursor:
            body["start_cursor"] = cursor
        resp = notion_request("POST", f"/databases/{KIT_DB_ID}/query", body)
        pages.extend(resp["results"])
        if not resp.get("has_more"):
            break
        cursor = resp["next_cursor"]
    return pages


def parse_notion_date(prop: dict) -> Optional[datetime]:
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


def extract_page_fields(page: dict) -> dict:
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
        "last_contact": parse_notion_date(props.get("Last Contact") or {}),
        "reach_out_every": select_value("Reach Out Every"),
    }


def update_notion_page(
    page_id: str,
    last_contact: datetime,
    next_reach_out: Optional[datetime],
) -> None:
    props = {
        "Last Contact": {"date": {"start": last_contact.strftime("%Y-%m-%d")}},
    }
    if next_reach_out is not None:
        props["Next Reach Out"] = {"date": {"start": next_reach_out.strftime("%Y-%m-%d")}}
    notion_request("PATCH", f"/pages/{page_id}", {"properties": props})


def main() -> None:
    print(f"[kit_sync] {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} — starting")

    sent = get_sent_contacts(LOOKBACK_DAYS)
    print(f"[kit_sync] {len(sent)} contacts with sent messages in last {LOOKBACK_DAYS} days")

    kit_pages = get_kit_records()
    print(f"[kit_sync] {len(kit_pages)} KIT records loaded from Notion")

    updated = 0
    for page in kit_pages:
        fields = extract_page_fields(page)
        if not fields["phone"]:
            continue

        norm_kit = normalize_phone(fields["phone"])
        if not norm_kit or norm_kit not in sent:
            continue

        new_last_contact = sent[norm_kit]
        old_last_contact = fields["last_contact"]

        if old_last_contact and new_last_contact.date() <= old_last_contact.date():
            continue

        interval = REACH_OUT_DAYS.get(fields["reach_out_every"] or "")
        new_next: Optional[datetime] = None
        if interval is not None:
            new_next = (new_last_contact + timedelta(days=interval)).replace(
                hour=0, minute=0, second=0, microsecond=0
            )

        update_notion_page(fields["id"], new_last_contact, new_next)

        old_str = old_last_contact.strftime("%Y-%m-%d") if old_last_contact else "none"
        new_str = new_last_contact.strftime("%Y-%m-%d")
        next_str = new_next.strftime("%Y-%m-%d") if new_next else "unchanged"
        print(
            f"[kit_sync] Updated: {fields['name']}"
            f" | Last Contact: {old_str} → {new_str}"
            f" | Next Reach Out: {next_str}"
        )
        updated += 1

    print(f"[kit_sync] Done — {updated} record(s) updated")


if __name__ == "__main__":
    main()
