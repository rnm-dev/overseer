# Overseer patches

This is `desktop_webview_window` 0.3.0 from
<https://github.com/MixinNetwork/flutter-plugins/tree/main/packages/desktop_webview_window>.

Overseer changes `windows/web_view.cc` so ordinary HTTP and HTTPS navigations
continue synchronously. The upstream Windows implementation cancels every
navigation and replays it after an asynchronous Flutter method-channel round
trip. On current Flutter Windows runners that leaves the initial page or the
GitHub redirect stalled in an empty WebView.

Custom-scheme navigations still use the method-channel callback. This keeps the
app-owned OAuth return URI blocked from rendering and lets Overseer validate its
scheme, host, and path before accepting it.
