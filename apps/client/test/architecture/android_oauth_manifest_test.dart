import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

void main() {
  test('Android OAuth callback can return to the main app task', () {
    final manifest = File(
      'android/app/src/main/AndroidManifest.xml',
    ).readAsStringSync();
    final callbackSource = File(
      'android/app/src/main/kotlin/org/ovrseer/app/'
      'OAuthCallbackActivity.kt',
    ).readAsStringSync();
    final mainActivity = RegExp(
      r'<activity\s+android:name="\.MainActivity"[\s\S]*?</activity>',
    ).firstMatch(manifest)?.group(0);
    final callbackActivity = RegExp(
      r'<activity\s+'
      r'android:name="\.OAuthCallbackActivity"'
      r'[\s\S]*?</activity>',
    ).firstMatch(manifest)?.group(0);

    expect(mainActivity, isNotNull);
    expect(mainActivity, contains('android:launchMode="singleTop"'));
    expect(mainActivity, contains('android:taskAffinity=""'));

    expect(callbackActivity, isNotNull);
    expect(callbackActivity, contains('android:taskAffinity=""'));
    expect(callbackActivity, contains('android:host="oauth"'));
    expect(callbackActivity, contains('android:path="/github"'));
    expect(callbackSource, contains('FlutterWebAuth2Plugin.callbacks'));
    expect(callbackSource, contains('overseerTask.startActivity('));
    expect(
      callbackSource,
      contains(
        'AuthenticationManagementActivity.createResponseHandlingIntent(this)',
      ),
    );
    expect(callbackSource, contains('finish()'));
    expect(callbackSource, isNot(contains('finishAndRemoveTask()')));
  });
}
