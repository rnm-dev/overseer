import 'dart:async';
import 'dart:io';

import 'package:desktop_webview_window/desktop_webview_window.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

final htmlPreviewLauncherProvider = Provider<HtmlPreviewLauncher>(
  (ref) => const UnsupportedHtmlPreviewLauncher(),
);

abstract interface class HtmlPreviewLauncher {
  bool get supported;

  Future<void> open({required String title, required String document});
}

class UnsupportedHtmlPreviewLauncher implements HtmlPreviewLauncher {
  const UnsupportedHtmlPreviewLauncher();

  @override
  bool get supported => false;

  @override
  Future<void> open({required String title, required String document}) async {
    throw const HtmlPreviewException(
      'HTML browser preview is unavailable on this platform.',
    );
  }
}

class DesktopWebViewHtmlPreviewLauncher implements HtmlPreviewLauncher {
  DesktopWebViewHtmlPreviewLauncher({
    DesktopHtmlPreviewWindowFactory? windowFactory,
    this.temporaryRoot,
  }) : _windowFactory =
           windowFactory ?? const PluginDesktopHtmlPreviewWindowFactory();

  final DesktopHtmlPreviewWindowFactory _windowFactory;
  final Directory? temporaryRoot;

  @override
  bool get supported => true;

  @override
  Future<void> open({required String title, required String document}) async {
    if (!await _windowFactory.isAvailable()) {
      throw const HtmlPreviewException(
        'The desktop browser component is not installed.',
      );
    }

    final previewDirectory = await (temporaryRoot ?? Directory.systemTemp)
        .createTemp('overseer-html-preview-');
    final previewFile = File.fromUri(
      previewDirectory.uri.resolve('preview.html'),
    );

    try {
      await previewFile.writeAsString(document, flush: true);
      final window = await _windowFactory.create(
        title: title.trim().isEmpty ? 'HTML Preview' : '$title — Preview',
        userDataFolder: previewDirectory.uri
            .resolve('browser-profile/')
            .toFilePath(),
      );
      final previewUri = previewFile.absolute.uri;
      window.setUrlRequestHandler(
        (url) => _allowsNavigation(Uri.tryParse(url), previewUri),
      );
      unawaited(
        window.onClose.whenComplete(
          () => _deletePreviewDirectory(previewDirectory),
        ),
      );
      window.launch(previewUri);
    } on Object catch (error) {
      await _deletePreviewDirectory(previewDirectory);
      if (error is HtmlPreviewException) rethrow;
      throw const HtmlPreviewException(
        'The desktop browser preview could not be opened.',
      );
    }
  }
}

bool _allowsNavigation(Uri? requested, Uri previewUri) {
  if (requested == null) return false;
  if (requested.scheme == 'about' ||
      requested.scheme == 'data' ||
      requested.scheme == 'blob') {
    return true;
  }
  return requested.scheme == 'file' &&
      requested.toFilePath() == previewUri.toFilePath();
}

Future<void> _deletePreviewDirectory(Directory directory) async {
  try {
    if (await directory.exists()) {
      await directory.delete(recursive: true);
    }
  } on FileSystemException {
    // WebView2 can briefly retain profile files after the window closes.
    // Temporary storage is still bounded by the operating system.
  }
}

class HtmlPreviewException implements Exception {
  const HtmlPreviewException(this.message);

  final String message;

  @override
  String toString() => message;
}

abstract interface class DesktopHtmlPreviewWindowFactory {
  Future<bool> isAvailable();

  Future<DesktopHtmlPreviewWindow> create({
    required String title,
    required String userDataFolder,
  });
}

abstract interface class DesktopHtmlPreviewWindow {
  Future<void> get onClose;

  void setUrlRequestHandler(bool Function(String url) handler);

  void launch(Uri url);
}

class PluginDesktopHtmlPreviewWindowFactory
    implements DesktopHtmlPreviewWindowFactory {
  const PluginDesktopHtmlPreviewWindowFactory();

  @override
  Future<bool> isAvailable() => WebviewWindow.isWebviewAvailable();

  @override
  Future<DesktopHtmlPreviewWindow> create({
    required String title,
    required String userDataFolder,
  }) async {
    final webview = await WebviewWindow.create(
      configuration: CreateConfiguration(
        windowHeight: 720,
        windowWidth: 960,
        title: title,
        userDataFolderWindows: userDataFolder,
      ),
    );
    return PluginDesktopHtmlPreviewWindow(webview);
  }
}

class PluginDesktopHtmlPreviewWindow implements DesktopHtmlPreviewWindow {
  PluginDesktopHtmlPreviewWindow(this._webview);

  final Webview _webview;

  @override
  Future<void> get onClose => _webview.onClose;

  @override
  void setUrlRequestHandler(bool Function(String url) handler) {
    _webview.setOnUrlRequestCallback(handler);
  }

  @override
  void launch(Uri url) => _webview.launch(url.toString());
}
