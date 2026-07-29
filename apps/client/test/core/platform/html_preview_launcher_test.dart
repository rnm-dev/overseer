import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/core/platform/html_preview_launcher.dart';

void main() {
  test(
    'opens only the isolated local document and cleans it on close',
    () async {
      final temporaryRoot = await Directory.systemTemp.createTemp(
        'overseer-html-preview-test-',
      );
      addTearDown(() async {
        if (await temporaryRoot.exists()) {
          await temporaryRoot.delete(recursive: true);
        }
      });
      final window = _FakeDesktopHtmlPreviewWindow();
      final launcher = DesktopWebViewHtmlPreviewLauncher(
        windowFactory: _FakeDesktopHtmlPreviewWindowFactory(window),
        temporaryRoot: temporaryRoot,
      );

      await launcher.open(title: 'index.html', document: '<p>Preview</p>');

      final launchedUri = window.launchedUri;
      expect(launchedUri, isNotNull);
      expect(launchedUri!.scheme, 'file');
      expect(await File.fromUri(launchedUri).readAsString(), '<p>Preview</p>');
      expect(window.request(launchedUri.toString()), isTrue);
      expect(window.request('https://example.com'), isFalse);
      expect(window.request('data:image/png;base64,AA=='), isTrue);

      window.close();
      await window.onClose;
      for (
        var attempt = 0;
        attempt < 20 && temporaryRoot.listSync().isNotEmpty;
        attempt++
      ) {
        await Future<void>.delayed(const Duration(milliseconds: 5));
      }

      expect(temporaryRoot.listSync(), isEmpty);
    },
  );

  test('reports an unavailable desktop browser component', () async {
    final launcher = DesktopWebViewHtmlPreviewLauncher(
      windowFactory: const _UnavailableDesktopHtmlPreviewWindowFactory(),
    );

    await expectLater(
      launcher.open(title: 'index.html', document: '<p>Preview</p>'),
      throwsA(
        isA<HtmlPreviewException>().having(
          (error) => error.message,
          'message',
          contains('not installed'),
        ),
      ),
    );
  });
}

class _FakeDesktopHtmlPreviewWindowFactory
    implements DesktopHtmlPreviewWindowFactory {
  const _FakeDesktopHtmlPreviewWindowFactory(this.window);

  final _FakeDesktopHtmlPreviewWindow window;

  @override
  Future<bool> isAvailable() async => true;

  @override
  Future<DesktopHtmlPreviewWindow> create({
    required String title,
    required String userDataFolder,
  }) async {
    return window;
  }
}

class _UnavailableDesktopHtmlPreviewWindowFactory
    implements DesktopHtmlPreviewWindowFactory {
  const _UnavailableDesktopHtmlPreviewWindowFactory();

  @override
  Future<bool> isAvailable() async => false;

  @override
  Future<DesktopHtmlPreviewWindow> create({
    required String title,
    required String userDataFolder,
  }) {
    throw UnimplementedError();
  }
}

class _FakeDesktopHtmlPreviewWindow implements DesktopHtmlPreviewWindow {
  final Completer<void> _closed = Completer<void>();
  bool Function(String url)? _handler;
  Uri? launchedUri;

  @override
  Future<void> get onClose => _closed.future;

  @override
  void launch(Uri url) {
    launchedUri = url;
  }

  @override
  void setUrlRequestHandler(bool Function(String url) handler) {
    _handler = handler;
  }

  bool request(String url) => _handler!(url);

  void close() => _closed.complete();
}
