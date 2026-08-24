# FieldOPS TestFlight deployment

The iOS identifier is `pk.yousufrice.fieldops`, the Apple team is `V4AYP7YKGS`,
and the App Store Connect Apple ID is `6798195013`.

## One-time setup

1. Apple App ID `pk.yousufrice.fieldops` is registered.
2. App Store Connect app `Yousuf Rice FieldOps` exists with SKU `pk.yousufrice.fieldops` and full user access.
3. Copy `app-store-connect.env.example` to `.env.appstoreconnect.local`.
4. Add the App Store Connect key ID, issuer ID, and downloaded `AuthKey_<KEY_ID>.p8`.

## Build and upload from macOS

From the repository root:

```bash
corepack pnpm --filter @fieldops/mobile ios:asc:upload
```

The script installs the locked dependencies, generates the native iOS project, archives with automatic signing, and uploads to App Store Connect. After Apple finishes processing, add the internal testers in TestFlight.

## Xcode Cloud

The committed workspace is `apps/mobile/ios/YousufRiceFieldOps.xcworkspace` and
the scheme is `YousufRiceFieldOps`. The `ci_post_clone.sh` hook installs the
locked monorepo dependencies and CocoaPods; `ci_pre_xcodebuild.sh` synchronizes
the native marketing version from `app.json` and assigns an Xcode Cloud build
number no lower than 20. Configure an Archive action for iOS with App Store
Connect distribution and a TestFlight internal-testing post-action.

Xcode Cloud does not need an App Store Connect API key. It does require this
repository to be committed and pushed to a supported Git provider before the
workflow can be connected.

The current release line is version `1.0.4`, starting at build `20`. For future
releases, update `expo.version` and `ios.buildNumber` in `app.json` together with
the native target settings before pushing the Xcode Cloud build.
