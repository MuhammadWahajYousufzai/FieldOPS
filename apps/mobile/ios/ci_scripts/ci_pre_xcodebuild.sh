#!/bin/sh

set -eu

SCRIPT_DIRECTORY=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIRECTORY=$(CDPATH= cd -- "$SCRIPT_DIRECTORY/.." && pwd)
APP_CONFIG="$PROJECT_DIRECTORY/../app.json"
INFO_PLIST="$PROJECT_DIRECTORY/YousufRiceFieldOps/Info.plist"
PROJECT_FILE="$PROJECT_DIRECTORY/YousufRiceFieldOps.xcodeproj"
RELEASE_BUILD_FLOOR=19

release_metadata=$(
  /usr/bin/env node -e '
    const fs = require("fs");
    const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const version = config?.expo?.version;
    const buildNumber = config?.expo?.ios?.buildNumber;
    if (typeof version !== "string" || !version.trim()) process.exit(1);
    if (typeof buildNumber !== "string" || !buildNumber.trim()) process.exit(1);
    process.stdout.write(`${version.trim()}\n${buildNumber.trim()}\n`);
  ' "$APP_CONFIG"
) || {
  echo "Unable to read iOS release metadata from $APP_CONFIG" >&2
  exit 1
}
expo_version=$(printf '%s\n' "$release_metadata" | /usr/bin/sed -n '1p')
configured_build_number=$(printf '%s\n' "$release_metadata" | /usr/bin/sed -n '2p')

if ! printf '%s\n' "$expo_version" | /usr/bin/grep -Eq '^[0-9]+(\.[0-9]+){0,2}$'; then
  echo "Invalid iOS marketing version in app.json: $expo_version" >&2
  exit 1
fi
case "$configured_build_number" in
  *[!0-9]*|'')
    echo "Invalid iOS build number in app.json: $configured_build_number" >&2
    exit 1
    ;;
esac
if [ "$configured_build_number" -lt "$RELEASE_BUILD_FLOOR" ]; then
  echo "iOS build number in app.json must be at least $RELEASE_BUILD_FLOOR" >&2
  exit 1
fi

native_marketing_version=$(
  /usr/bin/xcodebuild \
    -project "$PROJECT_FILE" \
    -target YousufRiceFieldOps \
    -configuration Release \
    -showBuildSettings 2>/dev/null |
    /usr/bin/awk '$1 == "MARKETING_VERSION" && $2 == "=" { print $3; exit }'
)
if [ "$native_marketing_version" != "$expo_version" ]; then
  echo "Version mismatch: app.json is $expo_version but the iOS target is $native_marketing_version" >&2
  exit 1
fi

cloud_build_number=${CI_BUILD_NUMBER:-$configured_build_number}
case "$cloud_build_number" in
  *[!0-9]*|'') app_build_number=$configured_build_number ;;
  *) app_build_number=$cloud_build_number ;;
esac
if [ "$app_build_number" -lt "$configured_build_number" ]; then
  app_build_number=$configured_build_number
fi

cd "$PROJECT_DIRECTORY"
/usr/bin/xcrun agvtool new-version -all "$app_build_number"
/usr/libexec/PlistBuddy -c 'Set :CFBundleVersion $(CURRENT_PROJECT_VERSION)' "$INFO_PLIST"
echo "Using FieldOPS TestFlight version $expo_version ($app_build_number)"
