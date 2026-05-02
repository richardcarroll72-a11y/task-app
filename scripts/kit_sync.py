#!/usr/bin/env python3
"""
kit_sync.py — Syncs iMessage Last Contact dates + conversation summaries
to the Notion Keep In Touch Tracker.

Usage:
    kit_sync.py [--dry-run]

Requires env vars:
    NOTION_TOKEN        — Notion integration token
    ANTHROPIC_API_KEY   — Anthropic API key for Claude Haiku summarisation
    NOTION_DATABASE_ID  — To-Do database ID (for creating reach-out tasks)
"""

import argparse
import json
import os
import re
import shutil
import sqlite3
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from typing import Optional

# Add scripts directory to path so we can import kit_helpers
sys.path.insert(0, os.path.dirname(__file__))
import kit_helpers as kh

# ─── Config ──────────────────────────────────────────────────────────────────

CHAT_DB = os.path.expanduser("~/Library/Messages/chat.db")
NOTION_TOKEN = os.environ["NOTION_TOKEN"]
ANTHROPIC_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
TODO_DB_ID = os.environ.get("NOTION_DATABASE_ID", "")
LOOKBACK_DAYS = 30

# iMessage stores dates as nanoseconds since 2001-01-01 UTC
MAC_EPOCH = 978307200


# ─── iMessage helpers ─────────────────────────────────────────────────────────

def mac_ns_to_datetime(ts: int) -> datetime:
    unix_ts = ts / 1e9 + MAC_EPOCH
    return datetime.fromtimestamp(unix_ts, tz=timezone.utc)


def get_sent_contacts(lookback_days: int, conn: sqlite3.Connection) -> dict:
    """
    Returns {normalized_phone: latest_sent_datetime} for contacts messaged
    in the last lookback_days days.
    """
    cutoff_unix = (datetime.now(timezone.utc) - timedelta(days=lookback_days)).timestamp()
    cutoff_mac_ns = int((cutoff_unix - MAC_EPOCH) * 1e9)

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
        phone = row[0]
        last_date = row[1]
        if "@" in phone:  # skip email-based Apple IDs
            continue
        norm = kh.normalise_phone(phone)
        if not norm:
            continue
        dt = mac_ns_to_datetime(last_date)
        if norm not in results or dt > results[norm]:
            results[norm] = dt

    return results


def get_conversation_thread(
    conn: sqlite3.Connection,
    phone_norm: str,
    from_date: Optional[datetime],
    to_date: datetime,
    dry_run: bool = False,
) -> str:
    """
    Collect all messages (sent + received) for a phone number between
    from_date (exclusive, or 30 days ago if None) and to_date (inclusive).
    Returns a plain-text transcript suitable for summarisation.
    """
    if from_date is None:
        from_date = to_date - timedelta(days=30)

    from_mac = int((from_date.timestamp() - MAC_EPOCH) * 1e9)
    to_mac = int((to_date.timestamp() - MAC_EPOCH) * 1e9)

    # Find all handle IDs that match this normalised phone number
    handle_rows = conn.execute(
        "SELECT ROWID FROM handle WHERE id LIKE ?",
        (f"%{phone_norm[-7:]}%",),  # partial suffix match for area-code variants
    ).fetchall()
    if not handle_rows:
        return ""
    handle_ids = [r[0] for r in handle_rows]
    placeholders = ",".join("?" * len(handle_ids))

    # Collect all chat IDs that involve any of these handles
    chat_rows = conn.execute(
        f"SELECT DISTINCT chat_id FROM chat_handle_join WHERE handle_id IN ({placeholders})",
        handle_ids,
    ).fetchall()
    if not chat_rows:
        return ""
    chat_ids = [r[0] for r in chat_rows]
    chat_placeholders = ",".join("?" * len(chat_ids))

    # Fetch all messages in those chats within the date window, deduped by ROWID
    query = f"""
        SELECT DISTINCT m.ROWID, m.date, m.is_from_me, m.text
        FROM message m
        JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
        WHERE cmj.chat_id IN ({chat_placeholders})
          AND m.date > ?
          AND m.date <= ?
          AND m.text IS NOT NULL
          AND m.text != ''
        ORDER BY m.date ASC
    """
    rows = conn.execute(query, (*chat_ids, from_mac, to_mac)).fetchall()

    if not rows:
        return ""

    limit = 3 if dry_run else 200
    lines = []
    for rowid, ts, is_from_me, text in rows[:limit]:
        dt = mac_ns_to_datetime(ts)
        speaker = "Me" if is_from_me else "Them"
        lines.append(f"[{dt.strftime('%Y-%m-%d %H:%M')}] {speaker}: {text}")

    return "\n".join(lines)


# ─── Overdue To-Do creation ───────────────────────────────────────────────────

def _create_overdue_todos(
    kit_fields_list: list,
    notion_token: str,
    todo_db_id: str,
    dry_run: bool,
) -> int:
    """
    For each KIT contact whose Next Reach Out date is in the past and who
    doesn't already have a To-Do task, create one.
    """
    if not todo_db_id:
        return 0

    today = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    created = 0

    for fields in kit_fields_list:
        next_reach_out = kh.parse_notion_date({"date": {"start": fields.get("next_reach_out_raw")}} if fields.get("next_reach_out_raw") else None)
        if next_reach_out is None:
            continue
        if next_reach_out > today:
            continue

        name = fields["name"]
        if not name:
            continue

        last_contact = fields["last_contact"]
        last_method = fields.get("last_method") or "message"
        summary = fields.get("last_conversation") or ""
        notes = kh.format_kit_todo_notes(
            last_contact or today,
            summary,
            last_method,
        )

        if dry_run:
            print(f"[kit_sync] [dry-run] Would create To-Do: Reach out to {name}")
            continue

        _id, created_new = kh.upsert_kit_todo(
            notion_token, todo_db_id, name, notes, next_reach_out
        )
        if created_new:
            print(f"[kit_sync] Created To-Do: Reach out to {name}")
            created += 1

    return created


# ─── Main ────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="Preview changes without writing to Notion")
    args = parser.parse_args()
    dry_run = args.dry_run

    mode = "[dry-run] " if dry_run else ""
    print(f"[kit_sync] {mode}{datetime.now().strftime('%Y-%m-%d %H:%M:%S')} — starting")

    if not ANTHROPIC_KEY and not dry_run:
        print("[kit_sync] WARNING: ANTHROPIC_API_KEY not set — summaries will be skipped")

    # Copy chat.db to temp to avoid locking
    tmp = tempfile.mktemp(suffix=".db")
    shutil.copy2(CHAT_DB, tmp)

    try:
        conn = sqlite3.connect(tmp)

        sent = get_sent_contacts(LOOKBACK_DAYS, conn)
        print(f"[kit_sync] {len(sent)} contacts with sent messages in last {LOOKBACK_DAYS} days")

        kit_pages = kh.get_kit_records(NOTION_TOKEN)
        print(f"[kit_sync] {len(kit_pages)} KIT records loaded from Notion")

        kit_fields_list = [kh.extract_kit_fields(p) for p in kit_pages]

        updated = 0
        for fields in kit_fields_list:
            if not fields["phone"]:
                continue

            norm_kit = kh.normalise_phone(fields["phone"])
            if not norm_kit or norm_kit not in sent:
                continue

            new_last_contact = sent[norm_kit]
            old_last_contact = fields["last_contact"]

            if old_last_contact and new_last_contact.date() <= old_last_contact.date():
                continue

            # Collect conversation thread
            thread_text = get_conversation_thread(
                conn,
                norm_kit,
                old_last_contact,
                new_last_contact,
                dry_run=dry_run,
            )

            if dry_run:
                preview_lines = thread_text.split("\n")[:3]
                print(f"\n[kit_sync] [dry-run] Would update: {fields['name']}")
                print(f"  Last Contact: {old_last_contact.strftime('%Y-%m-%d') if old_last_contact else 'none'} → {new_last_contact.strftime('%Y-%m-%d')}")
                print(f"  Thread preview ({len(thread_text.split(chr(10)))} messages):")
                for line in preview_lines:
                    print(f"    {line}")
                if len(thread_text.split("\n")) > 3:
                    print("    ...")
                continue

            # Summarise with Claude
            summary = ""
            if ANTHROPIC_KEY and thread_text:
                try:
                    summary = kh.summarise_with_claude(
                        ANTHROPIC_KEY, fields["name"], thread_text, "iMessage"
                    )
                except Exception as e:
                    print(f"[kit_sync] WARNING: Claude summarisation failed for {fields['name']}: {e}")

            # Compute next reach-out
            next_reach_out = kh.compute_next_reach_out(new_last_contact, fields["reach_out_every"])

            # Update Notion
            updates = {
                "last_contact": new_last_contact,
                "last_method": "iMessage",
            }
            if next_reach_out:
                updates["next_reach_out"] = next_reach_out
            if summary:
                updates["last_conversation"] = summary

            kh.update_kit_record(NOTION_TOKEN, fields["id"], updates)

            # Update To-Do task notes if it exists
            if TODO_DB_ID and summary:
                notes = kh.format_kit_todo_notes(
                    new_last_contact, summary, "iMessage"
                )
                kh.upsert_kit_todo(
                    NOTION_TOKEN, TODO_DB_ID, fields["name"], notes, next_reach_out
                )

            old_str = old_last_contact.strftime("%Y-%m-%d") if old_last_contact else "none"
            new_str = new_last_contact.strftime("%Y-%m-%d")
            next_str = next_reach_out.strftime("%Y-%m-%d") if next_reach_out else "unchanged"
            summ_str = f" | Summary: {summary[:60]}…" if summary else ""
            print(
                f"[kit_sync] Updated: {fields['name']}"
                f" | Last Contact: {old_str} → {new_str}"
                f" | Next Reach Out: {next_str}"
                f"{summ_str}"
            )
            updated += 1

        conn.close()

        if not dry_run:
            # Create To-Do tasks for overdue contacts
            todos = _create_overdue_todos(kit_fields_list, NOTION_TOKEN, TODO_DB_ID, dry_run)
            print(f"[kit_sync] Done — {updated} record(s) updated, {todos} To-Do task(s) created")
        else:
            print(f"\n[kit_sync] [dry-run] Done — {updated} record(s) would be updated")

    finally:
        import os as _os
        try:
            _os.unlink(tmp)
        except Exception:
            pass


if __name__ == "__main__":
    main()
