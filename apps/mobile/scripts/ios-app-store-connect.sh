#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOBILE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$MOBILE_DIR/../.." && pwd)"
LOCAL_ENV="$MOBILE_DIR/.env.appstoreconnect.local"
MODE="${1:-upload}"

if [[ "$MODE" != "upload" && "$MODE" != "export" ]]; then
  echo "Usage: $0 [upload|export]" >&2
  exit 2
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "iOS archives require macOS with Xcode. Run this script on a connected Mac or Xcode Cloud runner." >&2
  exit 1
fi

if [[ -f "$LOCAL_ENV" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$LOCAL_ENV"
  set +a
fi

: "${ASC_KEY_ID:?Set ASC_KEY_ID in $LOCAL_ENV}"
: "${ASC_ISSUER_ID:?Set ASC_ISSUER_ID in $LOCAL_ENV}"
: "${APPLE_TEAM_ID:=V4AYP7YKGS}"

ASC_KEY_PATH="${ASC_KEY_PATH:-$MOBILE_DIR/AuthKey_${ASC_KEY_ID}.p8}"
[[ -f "$ASC_KEY_PATH" ]] || { echo "Missing App Store Connect key: $ASC_KEY_PATH" >&2; exit 1; }

cd "$REPO_ROOT"
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @fieldops/mobile exec expo prebuild --platform ios

WORKSPACE="$MOBILE_DIR/ios/YousufRiceFieldOps.xcworkspace"
SCHEME="YousufRiceFieldOps"
ARCHIVE_PATH="$MOBILE_DIR/build/YousufRiceFieldOps.xcarchive"
EXPORT_PATH="$MOBILE_DIR/build/app-store-connect-$MODE"
EXPORT_OPTIONS="$MOBILE_DIR/build/ExportOptions-$MODE.plist"
mkdir -p "$MOBILE_DIR/build"

cat > "$EXPORT_OPTIONS" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>destination</key><string>$MODE</string>
  <key>manageAppVersionAndBuildNumber</key><true/>
  <key>method</key><string>app-store-connect</string>
  <key>signingStyle</key><string>automatic</string>
  <key>teamID</key><string>$APPLE_TEAM_ID</string>
  <key>uploadSymbols</key><true/>
</dict></plist>
PLIST

xcodebuild archive \
  -workspace "$WORKSPACE" -scheme "$SCHEME" -configuration Release \
  -destination "generic/platform=iOS" -archivePath "$ARCHIVE_PATH" \
  -allowProvisioningUpdates \
  -authenticationKeyPath "$ASC_KEY_PATH" \
  -authenticationKeyID "$ASC_KEY_ID" \
  -authenticationKeyIssuerID "$ASC_ISSUER_ID"

xcodebuild -exportArchive \
  -archivePath "$ARCHIVE_PATH" -exportPath "$EXPORT_PATH" \
  -exportOptionsPlist "$EXPORT_OPTIONS" -allowProvisioningUpdates \
  -authenticationKeyPath "$ASC_KEY_PATH" \
  -authenticationKeyID "$ASC_KEY_ID" \
  -authenticationKeyIssuerID "$ASC_ISSUER_ID"

echo "Finished: $EXPORT_PATH"
