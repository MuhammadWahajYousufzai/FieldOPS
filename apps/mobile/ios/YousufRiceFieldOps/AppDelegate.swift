internal import Expo
import Foundation
import React
import ReactAppDependencyProvider

@main
class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?

  var reactNativeDelegate: ExpoReactNativeFactoryDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  /// Expo persists TaskManager registrations in UserDefaults across app
  /// updates. Older FieldOPS builds registered a background location task that
  /// the foreground-only app no longer uses. Remove only that verified legacy
  /// registration before Expo restores native tasks during launch.
  private func removeLegacyLocationTaskRegistration() {
    let defaults = UserDefaults.standard
    let serviceKey = "EXTaskService"
    let taskName = "fieldops-minute-route-v1"
    guard var service = defaults.dictionary(forKey: serviceKey) else { return }

    var changed = false
    for appID in Array(service.keys) {
      guard var app = service[appID] as? [String: Any],
            var tasks = app["tasks"] as? [String: Any],
            let task = tasks[taskName] as? [String: Any],
            task["consumerClass"] as? String == "EXLocationTaskConsumer" else { continue }

      tasks.removeValue(forKey: taskName)
      app["tasks"] = tasks
      service[appID] = app
      changed = true
    }

    if changed {
      defaults.set(service, forKey: serviceKey)
    }
  }

  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    removeLegacyLocationTaskRegistration()

    let delegate = ReactNativeDelegate()
    let factory = ExpoReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  // Linking API
  public override func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    return super.application(app, open: url, options: options) || RCTLinkingManager.application(app, open: url, options: options)
  }

  // Universal Links
  public override func application(
    _ application: UIApplication,
    continue userActivity: NSUserActivity,
    restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void
  ) -> Bool {
    let result = RCTLinkingManager.application(application, continue: userActivity, restorationHandler: restorationHandler)
    return super.application(application, continue: userActivity, restorationHandler: restorationHandler) || result
  }
}

class ReactNativeDelegate: ExpoReactNativeFactoryDelegate {
  // Extension point for config-plugins

  override func sourceURL(for bridge: RCTBridge) -> URL? {
    // needed to return the correct URL for expo-dev-client.
    bridge.bundleURL ?? bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    return RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: ".expo/.virtual-metro-entry")
#else
    return Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}
