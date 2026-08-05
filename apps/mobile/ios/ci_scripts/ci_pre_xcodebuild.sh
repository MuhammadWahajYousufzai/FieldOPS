#!/bin/sh

set -eu

SCRIPT_DIRECTORY=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIRECTORY=$(CDPATH= cd -- "$SCRIPT_DIRECTORY/.." && pwd)
INFO_PLIST="$PROJECT_DIRECTORY/YousufRiceFieldOps/Info.plist"

cloud_build_number=${CI_BUILD_NUMBER:-1}
case "$cloud_build_number" in
  *[!0-9]*|'') app_build_number=1 ;;
  *) app_build_number=$cloud_build_number ;;
esac

cd "$PROJECT_DIRECTORY"
/usr/bin/xcrun agvtool new-version -all "$app_build_number"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $app_build_number" "$INFO_PLIST"
echo "Using FieldOPS TestFlight build number $app_build_number"
