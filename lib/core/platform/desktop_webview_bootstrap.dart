import 'package:desktop_webview_window/desktop_webview_window.dart';

/// Handles the helper process used by desktop OAuth WebView windows.
///
/// Returns `true` when this process belongs to the WebView title bar and the
/// main application must not be started.
bool handleDesktopWebViewProcess(List<String> arguments) {
  return runWebViewTitleBarWidget(arguments);
}
