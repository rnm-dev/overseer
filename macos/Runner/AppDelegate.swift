import Cocoa
import FlutterMacOS

@main
class AppDelegate: FlutterAppDelegate {
  private var oauthChannel: FlutterMethodChannel?
  private var oauthListening = false

  override func applicationDidFinishLaunching(_ notification: Notification) {
    if let controller = mainFlutterWindow?.contentViewController as? FlutterViewController {
      let channel = FlutterMethodChannel(
        name: "org.ovrseer.app/oauth",
        binaryMessenger: controller.engine.binaryMessenger
      )
      channel.setMethodCallHandler { [weak self] call, result in
        switch call.method {
        case "beginOAuth":
          self?.oauthListening = true
          result(nil)
        case "endOAuth":
          self?.oauthListening = false
          result(nil)
        default:
          result(FlutterMethodNotImplemented)
        }
      }
      oauthChannel = channel
    }
    super.applicationDidFinishLaunching(notification)
  }

  override func application(_ application: NSApplication, open urls: [URL]) {
    super.application(application, open: urls)
    guard oauthListening, let callback = urls.first else {
      return
    }
    oauthListening = false
    oauthChannel?.invokeMethod("oauthCallback", arguments: callback.absoluteString)
    mainFlutterWindow?.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  override func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    return true
  }

  override func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool {
    return true
  }
}
