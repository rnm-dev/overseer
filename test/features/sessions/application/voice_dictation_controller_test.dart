import 'dart:async';
import 'dart:typed_data';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/features/sessions/application/voice_dictation_controller.dart';
import 'package:overseer_mobile/features/sessions/domain/followup_repository.dart';
import 'package:overseer_mobile/features/sessions/domain/voice_input.dart';

void main() {
  const scope = FollowupScope(
    workspaceId: 'workspace',
    peonId: 'peon',
    sessionId: 'session',
  );

  test('hides the microphone when the instance disables voice', () async {
    final container = ProviderContainer(
      overrides: [
        voiceInputRepositoryProvider.overrideWithValue(
          _FakeRepository(enabled: false),
        ),
        voiceRecorderFactoryProvider.overrideWithValue(_FakeRecorderFactory()),
      ],
    );
    addTearDown(container.dispose);

    final subscription = container.listen(
      voiceDictationControllerProvider(scope),
      (_, _) {},
      fireImmediately: true,
    );
    addTearDown(subscription.close);
    await Future<void>.delayed(Duration.zero);

    final state = container.read(voiceDictationControllerProvider(scope));
    expect(state.phase, VoiceDictationPhase.unavailable);
    expect(state.showMicrophone, isFalse);
  });

  test('surfaces permanent denial with a settings recovery action', () async {
    final permissions = _FakePermissionGateway(
      MicrophonePermission.permanentlyDenied,
    );
    final container = ProviderContainer(
      overrides: [
        voiceInputRepositoryProvider.overrideWithValue(_FakeRepository()),
        voiceRecorderFactoryProvider.overrideWithValue(_FakeRecorderFactory()),
        microphonePermissionGatewayProvider.overrideWithValue(permissions),
      ],
    );
    addTearDown(container.dispose);

    final subscription = container.listen(
      voiceDictationControllerProvider(scope),
      (_, _) {},
      fireImmediately: true,
    );
    addTearDown(subscription.close);
    await Future<void>.delayed(Duration.zero);
    final started = await container
        .read(voiceDictationControllerProvider(scope).notifier)
        .start();

    final state = container.read(voiceDictationControllerProvider(scope));
    expect(started, isFalse);
    expect(state.canOpenSettings, isTrue);
    expect(state.error, contains('system settings'));
    await container
        .read(voiceDictationControllerProvider(scope).notifier)
        .openSettings();
    expect(permissions.openedSettings, isTrue);
  });

  test('discards silence and publishes audible transcription once', () async {
    final repository = _FakeRepository(text: 'Привет, mixed world.');
    final recorder = _FakeRecorder(
      take: VoiceTake(
        bytes: Uint8List.fromList([1, 2, 3]),
        duration: const Duration(seconds: 1),
        rms: 0.1,
      ),
    );
    final container = ProviderContainer(
      overrides: [
        voiceInputRepositoryProvider.overrideWithValue(repository),
        voiceRecorderFactoryProvider.overrideWithValue(
          _FakeRecorderFactory(recorder),
        ),
        microphonePermissionGatewayProvider.overrideWithValue(
          _FakePermissionGateway(MicrophonePermission.granted),
        ),
      ],
    );
    addTearDown(container.dispose);

    final subscription = container.listen(
      voiceDictationControllerProvider(scope),
      (_, _) {},
      fireImmediately: true,
    );
    addTearDown(subscription.close);
    await Future<void>.delayed(Duration.zero);
    final controller = container.read(
      voiceDictationControllerProvider(scope).notifier,
    );
    expect(await controller.start(), isTrue);
    recorder.emitAmplitude(0.7);
    await controller.stop();

    final state = container.read(voiceDictationControllerProvider(scope));
    expect(state.phase, VoiceDictationPhase.idle);
    expect(state.completedText, 'Привет, mixed world.');
    expect(state.completionId, 1);
    expect(repository.transcriptionCalls, 1);

    recorder.take = VoiceTake(
      bytes: Uint8List.fromList([4]),
      duration: const Duration(seconds: 1),
      rms: 0.001,
    );
    expect(await controller.start(), isTrue);
    await controller.stop();
    expect(repository.transcriptionCalls, 1);
    expect(
      container.read(voiceDictationControllerProvider(scope)).error,
      'No speech was detected.',
    );
  });
}

class _FakeRepository implements VoiceInputRepository {
  _FakeRepository({this.enabled = true, this.text = ''});

  final bool enabled;
  final String text;
  int transcriptionCalls = 0;

  @override
  Future<VoiceCapabilities> capabilities() async => VoiceCapabilities(
    enabled: enabled,
    maxDuration: const Duration(seconds: 120),
    maxBytes: 1024,
    mediaTypes: const ['audio/mp4'],
    polish: true,
  );

  @override
  Future<VoiceTranscription> transcribe({
    required FollowupScope scope,
    required Uint8List audio,
  }) async {
    transcriptionCalls++;
    return VoiceTranscription(text: text);
  }
}

class _FakePermissionGateway implements MicrophonePermissionGateway {
  _FakePermissionGateway(this.permission);

  final MicrophonePermission permission;
  bool openedSettings = false;

  @override
  Future<bool> openSettings() async {
    openedSettings = true;
    return true;
  }

  @override
  Future<MicrophonePermission> request() async => permission;
}

class _FakeRecorderFactory implements VoiceRecorderFactory {
  _FakeRecorderFactory([VoiceRecorder? recorder])
    : recorder = recorder ?? _FakeRecorder();

  final VoiceRecorder recorder;

  @override
  VoiceRecorder create() => recorder;
}

class _FakeRecorder implements VoiceRecorder {
  _FakeRecorder({VoiceTake? take})
    : take =
          take ??
          VoiceTake(bytes: Uint8List(0), duration: Duration.zero, rms: 0);

  VoiceTake take;
  final StreamController<double> _amplitudes =
      StreamController<double>.broadcast();
  final StreamController<void> _interruptions =
      StreamController<void>.broadcast();

  void emitAmplitude(double value) => _amplitudes.add(value);

  @override
  Stream<double> get amplitude => _amplitudes.stream;

  @override
  Stream<void> get interruptions => _interruptions.stream;

  @override
  bool get supported => true;

  @override
  Future<void> cancel() async {}

  @override
  Future<void> dispose() async {
    await _amplitudes.close();
    await _interruptions.close();
  }

  @override
  Future<void> start() async {}

  @override
  Future<VoiceTake> stop() async => take;
}
