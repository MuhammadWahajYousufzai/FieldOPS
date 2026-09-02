import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Android location tasks declare the permission required for persisted jobs", () => {
  const config = JSON.parse(readFileSync(new URL("../app.json", import.meta.url), "utf8"));
  const manifest = readFileSync(new URL("../android/app/src/main/AndroidManifest.xml", import.meta.url), "utf8");
  const locationPlugin = config.expo.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === "expo-location");

  // TaskManager schedules persisted JobScheduler jobs when background fixes arrive.
  // Without this install-time permission, Android terminates the receiver process.
  if (locationPlugin?.[1]?.isAndroidBackgroundLocationEnabled) {
    assert.ok(config.expo.android.permissions.includes("RECEIVE_BOOT_COMPLETED"),
      "Expo prebuild must preserve permission for persisted location jobs");
    assert.match(manifest, /<uses-permission\s+android:name="android\.permission\.RECEIVE_BOOT_COMPLETED"\s*\/>/,
      "The checked-in Android project must support persisted location jobs");
  }
});
