#!/bin/bash
# kit_sync_launch.sh
# LaunchAgent wrapper for the kit-sync job.
#
# Loads the Notion API token from an external secrets file that is kept OUT of
# git (~/.config/kit_sync/notion_token), exports it as NOTION_TOKEN, then execs
# the kit-sync runner. This keeps the live token out of the plist and the repo.
#
# To set up the secret on a new machine:
#   mkdir -p ~/.config/kit_sync
#   printf '%s' 'YOUR_NOTION_TOKEN_HERE' > ~/.config/kit_sync/notion_token
#   chmod 600 ~/.config/kit_sync/notion_token

set -euo pipefail

SECRETS_FILE="$HOME/.config/kit_sync/notion_token"

if [ ! -f "$SECRETS_FILE" ]; then
    echo "ERROR: secrets file not found: $SECRETS_FILE" >&2
    echo "Create it with the Notion token (see header of this script)." >&2
    exit 1
fi

# Strip any surrounding whitespace/newlines from the token.
NOTION_TOKEN="$(tr -d '[:space:]' < "$SECRETS_FILE")"
export NOTION_TOKEN

if [ -z "$NOTION_TOKEN" ]; then
    echo "ERROR: secrets file is empty: $SECRETS_FILE" >&2
    exit 1
fi

exec /Users/richardcarroll/Library/Scripts/KitSyncRunner.app/Contents/MacOS/kit-sync-runner
