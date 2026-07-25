import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/core/config/overseer_connection_store.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  group('parseOverseerServerUrl', () {
    test('accepts HTTP and HTTPS server URLs', () {
      expect(
        parseOverseerServerUrl(' https://overseer.example/ '),
        Uri.parse('https://overseer.example'),
      );
      expect(
        parseOverseerServerUrl('http://192.168.1.20:3000'),
        Uri.parse('http://192.168.1.20:3000'),
      );
    });

    test('rejects unsupported or incomplete URLs', () {
      expect(parseOverseerServerUrl('overseer.example'), isNull);
      expect(parseOverseerServerUrl('ftp://overseer.example'), isNull);
      expect(parseOverseerServerUrl('https:///missing-host'), isNull);
      expect(parseOverseerServerUrl('https://user@overseer.example'), isNull);
      expect(
        parseOverseerServerUrl('https://overseer.example?debug=1'),
        isNull,
      );
      expect(
        parseOverseerServerUrl('https://overseer.example#fragment'),
        isNull,
      );
    });
  });

  test('stores multiple normalized connections in insertion order', () async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    final store = SharedPreferencesOverseerConnectionStore();

    await store.add(Uri.parse('https://one.example/'));
    final connections = await store.add(Uri.parse('http://two.example:3000'));

    expect(connections.map((connection) => connection.serverUrl), <Uri>[
      Uri.parse('https://one.example'),
      Uri.parse('http://two.example:3000'),
    ]);
    final preferences = await SharedPreferences.getInstance();
    expect(
      preferences.getStringList(
        SharedPreferencesOverseerConnectionStore.preferenceKey,
      ),
      <String>['https://one.example', 'http://two.example:3000'],
    );
  });

  test('migrates the previous single URL without duplicating it', () async {
    SharedPreferences.setMockInitialValues(<String, Object>{
      SharedPreferencesOverseerConnectionStore.legacyPreferenceKey:
          'https://legacy.example/',
      SharedPreferencesOverseerConnectionStore.preferenceKey: <String>[
        'https://legacy.example',
        'https://new.example',
      ],
    });
    final store = SharedPreferencesOverseerConnectionStore();

    final connections = await store.readAll();

    expect(connections, hasLength(2));
    expect(connections.first.serverUrl, Uri.parse('https://legacy.example'));
    expect(connections.first.usesLegacyStorage, isTrue);
    expect(connections.last.serverUrl, Uri.parse('https://new.example'));
    expect(connections.last.usesLegacyStorage, isFalse);
  });

  test('rejects a duplicate normalized URL', () async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    final store = SharedPreferencesOverseerConnectionStore();
    await store.add(Uri.parse('https://overseer.example'));

    await expectLater(
      store.add(Uri.parse('https://overseer.example/')),
      throwsA(isA<DuplicateOverseerConnectionException>()),
    );
  });

  test('uses a stable connection storage identifier', () {
    expect(
      overseerConnectionStorageId(Uri.parse('https://overseer.example/')),
      overseerConnectionStorageId(Uri.parse('https://overseer.example')),
    );
    expect(
      overseerConnectionStorageId(Uri.parse('https://overseer.example')),
      isNot(overseerConnectionStorageId(Uri.parse('https://other.example'))),
    );
  });
}
