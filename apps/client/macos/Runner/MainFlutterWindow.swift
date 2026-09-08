import Cocoa
import FlutterMacOS

class MainFlutterWindow: NSWindow {
  override func awakeFromNib() {
    let flutterViewController = FlutterViewController()
    let windowFrame = self.frame
    self.contentViewController = flutterViewController
    self.setFrame(windowFrame, display: true)
    self.minSize = NSSize(width: 480, height: 480)
    // Keep the operator's chosen size and position between launches.
    if !self.setFrameUsingName("OverseerMainWindow") {
      self.setContentSize(NSSize(width: 1180, height: 780))
      self.center()
    }
    self.setFrameAutosaveName("OverseerMainWindow")

    RegisterGeneratedPlugins(registry: flutterViewController)

    super.awakeFromNib()
  }
}
