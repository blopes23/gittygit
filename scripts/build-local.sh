#!/bin/sh
# Build Gittygit locally with update signing.
# Private key: ~/.tauri/gittygit.key — password: macOS Keychain item "gittygit-updater-key-password".
set -e
KEY_FILE="${GITTYGIT_UPDATER_KEY:-$HOME/.tauri/gittygit.key}"
[ -f "$KEY_FILE" ] || { echo "Missing update signing key at $KEY_FILE" >&2; exit 1; }
TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY_FILE")"
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(security find-generic-password -s gittygit-updater-key-password -w)"
export TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD
# Stable code-signing identity (self-signed, in the login keychain) so macOS keeps
# folder-access permissions across updates. Falls back to ad-hoc signing if absent.
if security find-identity -p codesigning | grep -q '"Gittygit Self-Signed"'; then
  export APPLE_SIGNING_IDENTITY="Gittygit Self-Signed"
fi
exec npx tauri build "$@"
