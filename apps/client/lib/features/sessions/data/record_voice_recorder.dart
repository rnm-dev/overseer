import 'dart:async';
import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:audio_session/audio_session.dart';
import 'package:path_provider/path_provider.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:record/record.dart';

import '../../../core/time/app_time.dart';
import '../domain/voice_input.dart';

class PermissionHandlerMicrophoneGateway
    implements MicrophonePermissionGateway {
  const PermissionHandlerMicrophoneGateway();

  @override
  Future<MicrophonePermission> request() async {
    var status = await Permission.microphone.status;
    if (status.isDenied) status = await Permission.microphone.request();
    if (status.isGranted || status.isLimited) {
      return MicrophonePermission.granted;
    }
    if (status.isPermanentlyDenied) {
      return MicrophonePermission.permanentlyDenied;
    }
    if (status.isRestricted) return MicrophonePermission.restricted;
    return MicrophonePermission.denied;
  }

  @override
  Future<bool> openSettings() => openAppSettings();
}

class RecordVoiceRecorderFactory implements VoiceRecorderFactory {
  const RecordVoiceRecorderFactory({
    required this.supported,
    required this.silenceThresholdRms,
    this.clock = const SystemAppClock(),
  });

  final bool supported;
  final double? silenceThresholdRms;
  final AppClock clock;

  @override
  VoiceRecorder create() => RecordVoiceRecorder(
    supported: supported,
    silenceThresholdRms: silenceThresholdRms,
    clock: clock,
  );
}

class RecordVoiceRecorder implements VoiceRecorder {
  RecordVoiceRecorder({
    required this.supported,
    required this.silenceThresholdRms,
    this.clock = const SystemAppClock(),
  });

  @override
  final bool supported;
  @override
  final double? silenceThresholdRms;
  final AppClock clock;
  final AudioRecorder _recorder = AudioRecorder();
  final StreamController<double> _amplitudeController =
      StreamController<double>.broadcast();
  final StreamController<void> _interruptionController =
      StreamController<void>.broadcast();
  final List<double> _linearAmplitudeSamples = [];
  StreamSubscription<Amplitude>? _amplitudeSubscription;
  StreamSubscription<AudioInterruptionEvent>? _interruptionSubscription;
  AudioSession? _audioSession;
  AudioSessionConfiguration? _previousConfiguration;
  Stopwatch? _stopwatch;
  bool _recording = false;

  @override
  Stream<double> get amplitude => _amplitudeController.stream;

  @override
  Stream<void> get interruptions => _interruptionController.stream;

  @override
  Future<void> start() async {
    if (_recording) return;
    final session = await AudioSession.instance;
    _audioSession = session;
    _previousConfiguration = session.configuration;
    await session.configure(
      const AudioSessionConfiguration(
        avAudioSessionCategory: AVAudioSessionCategory.playAndRecord,
        avAudioSessionMode: AVAudioSessionMode.measurement,
        androidAudioAttributes: AndroidAudioAttributes(
          contentType: AndroidAudioContentType.speech,
          usage: AndroidAudioUsage.voiceCommunication,
        ),
        androidAudioFocusGainType: AndroidAudioFocusGainType.gainTransient,
        androidWillPauseWhenDucked: true,
      ),
    );
    if (!await session.setActive(true)) {
      throw const VoiceInputException(
        VoiceInputErrorKind.unavailable,
        'The microphone is currently in use by another app.',
      );
    }

    try {
      final directory = await getTemporaryDirectory();
      final path =
          '${directory.path}/overseer-dictation-'
          '${clock.now().microsecondsSinceEpoch}.m4a';
      _linearAmplitudeSamples.clear();
      _interruptionSubscription = session.interruptionEventStream.listen((
        event,
      ) {
        if (event.begin && _recording) _interruptionController.add(null);
      });
      await _recorder.start(
        const RecordConfig(
          encoder: AudioEncoder.aacLc,
          bitRate: 32000,
          sampleRate: 16000,
          numChannels: 1,
          audioInterruption: AudioInterruptionMode.none,
        ),
        path: path,
      );
      _recording = true;
      _stopwatch = Stopwatch()..start();
      _amplitudeSubscription = _recorder
          .onAmplitudeChanged(const Duration(milliseconds: 100))
          .listen((sample) {
            final normalized = ((sample.current + 60) / 60).clamp(0.0, 1.0);
            final linear = math.pow(10, sample.current / 20).toDouble();
            _linearAmplitudeSamples.add(linear);
            _amplitudeController.add(normalized);
          });
    } catch (_) {
      await _stopMonitoring();
      await _restoreAudioSession();
      rethrow;
    }
  }

  @override
  Future<VoiceTake> stop() async {
    final duration = _stopwatch?.elapsed ?? Duration.zero;
    _stopwatch?.stop();
    try {
      final path = await _recorder.stop();
      final bytes = path == null ? <int>[] : await File(path).readAsBytes();
      if (path != null) {
        try {
          await File(path).delete();
        } on FileSystemException {
          // The recorder may already have cleaned up its temporary output.
        }
      }
      final meanSquare = _linearAmplitudeSamples.isEmpty
          ? 0.0
          : _linearAmplitudeSamples
                    .map((value) => value * value)
                    .reduce((left, right) => left + right) /
                _linearAmplitudeSamples.length;
      return VoiceTake(
        bytes: Uint8List.fromList(bytes),
        duration: duration,
        rms: math.sqrt(meanSquare),
      );
    } finally {
      _recording = false;
      await _stopMonitoring();
      await _restoreAudioSession();
    }
  }

  @override
  Future<void> cancel() async {
    _stopwatch?.stop();
    try {
      if (_recording) await _recorder.cancel();
    } finally {
      _recording = false;
      await _stopMonitoring();
      await _restoreAudioSession();
    }
  }

  Future<void> _stopMonitoring() async {
    await _amplitudeSubscription?.cancel();
    await _interruptionSubscription?.cancel();
    _amplitudeSubscription = null;
    _interruptionSubscription = null;
  }

  Future<void> _restoreAudioSession() async {
    final session = _audioSession;
    if (session == null) return;
    await session.setActive(false);
    await session.configure(
      _previousConfiguration ?? const AudioSessionConfiguration.music(),
    );
    _audioSession = null;
    _previousConfiguration = null;
  }

  @override
  Future<void> dispose() async {
    await cancel();
    await _recorder.dispose();
    await _amplitudeController.close();
    await _interruptionController.close();
  }
}
