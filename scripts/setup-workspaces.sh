#!/usr/bin/env bash
# Setup Wanie workspaces directory (Linux/macOS)
# Usage: sudo ./setup-workspaces.sh [USER] [GROUP]

set -euo pipefail
USER=${1:-$(whoami)}
GROUP=${2:-$USER}

# resolve workspacesDir from env or default (~/.wanie/workspaces)
WORKSPACES=${WANIE_WORKSPACES_DIR:-"$HOME/.wanie/workspaces"}

echo "Creating workspaces directory: $WORKSPACES"
mkdir -p "$WORKSPACES"

echo "Setting owner: $USER:$GROUP"
chown -R "$USER:$GROUP" "$WORKSPACES" || echo "chown failed or requires sudo"

echo "Setting permissions: 2770 (rwxrws---)"
chmod -R 2770 "$WORKSPACES" || echo "chmod failed"

# optional: create a shared group so multiple users can write
echo "Done. Ensure the intended users are members of group $GROUP to access the directory." 
