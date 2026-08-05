#!/bin/sh

set -eu

SCRIPT_DIRECTORY=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
MOBILE_DIRECTORY=$(CDPATH= cd -- "$SCRIPT_DIRECTORY/../.." && pwd)
REPOSITORY_DIRECTORY=$(CDPATH= cd -- "$MOBILE_DIRECTORY/../.." && pwd)

if ! command -v corepack >/dev/null 2>&1 &&
   ! command -v pnpm >/dev/null 2>&1 &&
   ! command -v npx >/dev/null 2>&1; then
  command -v brew >/dev/null 2>&1 || { echo "error: Homebrew is required to install Node.js."; exit 1; }
  brew install node
fi

if ! command -v pod >/dev/null 2>&1; then
  command -v brew >/dev/null 2>&1 || { echo "error: Homebrew is required to install CocoaPods."; exit 1; }
  brew install cocoapods
fi

cd "$REPOSITORY_DIRECTORY"
PNPM_VERSION="11.18.0"
if command -v corepack >/dev/null 2>&1; then
  corepack pnpm install --frozen-lockfile
elif command -v pnpm >/dev/null 2>&1; then
  pnpm install --frozen-lockfile
else
  npx --yes "pnpm@$PNPM_VERSION" install --frozen-lockfile
fi

cd "$MOBILE_DIRECTORY/ios"
pod install
