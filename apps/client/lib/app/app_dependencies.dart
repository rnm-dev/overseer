import 'dart:async';

import 'package:dio/dio.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:overseer_mobile/app/live_sync_lifecycle.dart';
import 'package:overseer_mobile/app/push_notification_lifecycle.dart';
import 'package:overseer_mobile/app/overseer_connection_authenticator.dart';
import 'package:overseer_mobile/core/config/app_config.dart';
import 'package:overseer_mobile/core/config/overseer_connection_store.dart';
import 'package:overseer_mobile/core/database/app_database.dart';
import 'package:overseer_mobile/core/diagnostics/app_diagnostics.dart';
import 'package:overseer_mobile/core/live/live_projection_sink.dart';
import 'package:overseer_mobile/core/live/transcript_live_service.dart';
import 'package:overseer_mobile/core/network/overseer_http_client.dart';
import 'package:overseer_mobile/core/notifications/default_push_notification_service.dart';
import 'package:overseer_mobile/core/notifications/dio_push_subscription_remote.dart';
import 'package:overseer_mobile/core/notifications/firebase_push_messaging_client.dart';
import 'package:overseer_mobile/core/notifications/notification_permission.dart';
import 'package:overseer_mobile/core/notifications/notification_routing.dart';
import 'package:overseer_mobile/core/notifications/push_notification_service.dart';
import 'package:overseer_mobile/core/platform/html_preview_launcher.dart';
import 'package:overseer_mobile/core/time/app_time.dart';
import 'package:overseer_mobile/features/auth/application/auth_controller.dart';
import 'package:overseer_mobile/features/auth/application/auth_state.dart';
import 'package:overseer_mobile/features/ai_stats/application/ai_stats_controller.dart';
import 'package:overseer_mobile/features/ai_stats/data/dio_ai_stats_repository.dart';
import 'package:overseer_mobile/features/fleet/application/fleet_controller.dart';
import 'package:overseer_mobile/features/fleet/data/dio_fleet_repository.dart';
import 'package:overseer_mobile/features/fleet/data/web_socket_fleet_live_service.dart';
import 'package:overseer_mobile/features/inquiries/application/plugin_inquiry_controller.dart';
import 'package:overseer_mobile/features/inquiries/data/dio_plugin_inquiry_repository.dart';
import 'package:overseer_mobile/features/projects/application/projects_controller.dart';
import 'package:overseer_mobile/features/projects/application/project_detail_controller.dart';
import 'package:overseer_mobile/features/projects/data/default_project_repository.dart';
import 'package:overseer_mobile/features/projects/data/dio_project_detail_repository.dart';
import 'package:overseer_mobile/features/peon/application/peon_settings_controller.dart';
import 'package:overseer_mobile/features/peon/application/peon_management_controller.dart';
import 'package:overseer_mobile/features/peon/data/dio_peon_management_repository.dart';
import 'package:overseer_mobile/features/peon/data/dio_peon_settings_repository.dart';
import 'package:overseer_mobile/features/settings/application/sound_pack_controller.dart';
import 'package:overseer_mobile/features/settings/data/audioplayers_sound_preview_player.dart';
import 'package:overseer_mobile/features/settings/data/audioplayers_work_sound_player.dart';
import 'package:overseer_mobile/features/settings/data/shared_preferences_sound_preference_store.dart';
import 'package:overseer_mobile/features/themes/application/connection_theme_controller.dart';
import 'package:overseer_mobile/features/themes/data/shared_preferences_connection_theme_store.dart';
import 'package:overseer_mobile/features/themes/data/dio_connection_theme_catalog_source.dart';
import 'package:overseer_mobile/features/sessions/application/sessions_controller.dart';
import 'package:overseer_mobile/features/sessions/application/attachment_clipboard_provider.dart';
import 'package:overseer_mobile/features/sessions/application/session_composer_controller.dart';
import 'package:overseer_mobile/features/sessions/application/transcript_controller.dart';
import 'package:overseer_mobile/features/sessions/application/voice_dictation_controller.dart';
import 'package:overseer_mobile/features/sessions/data/default_followup_repository.dart';
import 'package:overseer_mobile/features/sessions/data/default_attachment_clipboard.dart';
import 'package:overseer_mobile/features/sessions/data/default_new_session_repository.dart';
import 'package:overseer_mobile/features/sessions/data/default_session_repository.dart';
import 'package:overseer_mobile/features/sessions/data/dio_session_file_repository.dart';
import 'package:overseer_mobile/features/sessions/data/dio_voice_input_repository.dart';
import 'package:overseer_mobile/features/sessions/data/record_voice_recorder.dart';
import 'package:overseer_mobile/features/sessions/application/session_file_controller.dart';

/// Application composition root.
///
/// This is the only place where auth contracts are connected to concrete
/// transport, secure-storage, and browser implementations.
class AppDependencies extends StatelessWidget {
  const AppDependencies({
    super.key,
    required this.config,
    required this.connection,
    required this.notificationRouteStore,
    required this.child,
    this.onAuthenticated,
  });

  final AppConfig config;
  final OverseerConnection connection;
  final NotificationRouteStore notificationRouteStore;
  final Widget child;
  final VoidCallback? onAuthenticated;

  @override
  Widget build(BuildContext context) {
    final nativeFirebaseAvailable =
        !kIsWeb &&
        Firebase.apps.isNotEmpty &&
        (defaultTargetPlatform == TargetPlatform.android ||
            defaultTargetPlatform == TargetPlatform.iOS);
    return ProviderScope(
      overrides: [
        themeConnectionIdProvider.overrideWithValue(
          overseerConnectionStorageId(connection.serverUrl),
        ),
        connectionThemeStoreProvider.overrideWithValue(
          SharedPreferencesConnectionThemeStore(),
        ),
        connectionThemeCatalogSourceProvider.overrideWith((ref) {
          final dio = Dio(BaseOptions(baseUrl: config.apiUrl.toString()));
          ref.onDispose(() => dio.close(force: true));
          return DioConnectionThemeCatalogSource(dio);
        }),
        overseerServerUrlProvider.overrideWithValue(config.serverUrl),
        appDiagnosticsProvider.overrideWithValue(
          const DebugPrintAppDiagnostics(),
        ),
        htmlPreviewLauncherProvider.overrideWithValue(
          !kIsWeb &&
                  (defaultTargetPlatform == TargetPlatform.windows ||
                      defaultTargetPlatform == TargetPlatform.linux)
              ? DesktopWebViewHtmlPreviewLauncher()
              : const UnsupportedHtmlPreviewLauncher(),
        ),
        appDatabaseProvider.overrideWith((ref) {
          final database = AppDatabase(
            name: connection.usesLegacyStorage
                ? 'overseer_mobile'
                : 'overseer_mobile_${overseerConnectionStorageId(connection.serverUrl)}',
          );
          ref.onDispose(database.close);
          return database;
        }),
        sessionPrivateDataClearerProvider.overrideWith(
          (ref) =>
              () => ref.read(appDatabaseProvider).clearSessionPrivateData(),
        ),
        overseerHttpClientProvider.overrideWith((ref) {
          final session = ref.watch(authControllerProvider).session;
          if (session == null) {
            throw StateError('An authenticated session is required.');
          }
          final dio = createOverseerHttpClient(
            apiUrl: config.apiUrl,
            token: session.token,
          );
          ref.onDispose(() => dio.close(force: true));
          return dio;
        }),
        attachmentClipboardProvider.overrideWithValue(
          const DefaultAttachmentClipboard(),
        ),
        workspaceConnectionRecorderProvider.overrideWithValue(
          DefaultWorkspaceConnectionRecorder(
            store: notificationRouteStore,
            connection: connection,
          ),
        ),
        notificationPermissionGatewayProvider.overrideWithValue(
          nativeFirebaseAvailable
              ? FirebaseNotificationPermissionGateway()
              : const NoopNotificationPermissionGateway(),
        ),
        pushNotificationServiceProvider.overrideWith((ref) {
          final platform = switch (defaultTargetPlatform) {
            TargetPlatform.android => PushPlatform.android,
            TargetPlatform.iOS => PushPlatform.ios,
            _ => null,
          };
          if (!nativeFirebaseAvailable || platform == null) {
            return const NoopPushNotificationService();
          }
          final service = DefaultPushNotificationService(
            FirebasePushMessagingClient(),
            DioPushSubscriptionRemote(apiUrl: config.apiUrl),
            platform,
          );
          ref.onDispose(() => unawaited(service.dispose()));
          return service;
        }),
        aiStatsRepositoryProvider.overrideWith((ref) {
          final session = ref.watch(authControllerProvider).session;
          if (session == null) {
            throw StateError('An authenticated session is required.');
          }
          return DioAiStatsRepository(
            database: ref.watch(appDatabaseProvider),
            apiUrl: config.apiUrl,
            token: session.token,
            dio: ref.watch(overseerHttpClientProvider),
            clock: ref.watch(appClockProvider),
          );
        }),
        peonSettingsRepositoryProvider.overrideWith((ref) {
          final session = ref.watch(authControllerProvider).session;
          if (session == null) {
            throw StateError('An authenticated session is required.');
          }
          return DioPeonSettingsRepository(
            apiUrl: config.apiUrl,
            token: session.token,
            dio: ref.watch(overseerHttpClientProvider),
          );
        }),
        peonManagementRepositoryProvider.overrideWith((ref) {
          final session = ref.watch(authControllerProvider).session;
          if (session == null) {
            throw StateError('An authenticated session is required.');
          }
          return DioPeonManagementRepository(
            database: ref.watch(appDatabaseProvider),
            apiUrl: config.apiUrl,
            token: session.token,
            dio: ref.watch(overseerHttpClientProvider),
            clock: ref.watch(appClockProvider),
          );
        }),
        pluginInquiryRepositoryProvider.overrideWith(
          (ref) =>
              DioPluginInquiryRepository(ref.watch(overseerHttpClientProvider)),
        ),
        projectRepositoryProvider.overrideWith((ref) {
          final session = ref.watch(authControllerProvider).session;
          if (session == null) {
            throw StateError('An authenticated session is required.');
          }
          return DefaultProjectRepository(
            database: ref.watch(appDatabaseProvider),
            apiUrl: config.apiUrl,
            token: session.token,
            dio: ref.watch(overseerHttpClientProvider),
          );
        }),
        projectDetailRepositoryProvider.overrideWith((ref) {
          final session = ref.watch(authControllerProvider).session;
          if (session == null) {
            throw StateError('An authenticated session is required.');
          }
          return DioProjectDetailRepository(
            apiUrl: config.apiUrl,
            token: session.token,
            dio: ref.watch(overseerHttpClientProvider),
          );
        }),
        sessionRepositoryProvider.overrideWith((ref) {
          final session = ref.watch(authControllerProvider).session;
          if (session == null) {
            throw StateError('An authenticated session is required.');
          }
          return DefaultSessionRepository(
            database: ref.watch(appDatabaseProvider),
            apiUrl: config.apiUrl,
            token: session.token,
            dio: ref.watch(overseerHttpClientProvider),
            clock: ref.watch(appClockProvider),
          );
        }),
        sessionFileRepositoryProvider.overrideWith((ref) {
          final session = ref.watch(authControllerProvider).session;
          if (session == null) {
            throw StateError('An authenticated session is required.');
          }
          return DioSessionFileRepository(
            apiUrl: config.apiUrl,
            token: session.token,
            dio: ref.watch(overseerHttpClientProvider),
          );
        }),
        voiceInputRepositoryProvider.overrideWith(
          (ref) => DioVoiceInputRepository(
            ref.watch(overseerHttpClientProvider),
            apiUrl: config.serverUrl.resolve('/api/v1/'),
          ),
        ),
        microphonePermissionGatewayProvider.overrideWithValue(
          const PermissionHandlerMicrophoneGateway(),
        ),
        voiceRecorderFactoryProvider.overrideWith(
          (ref) => RecordVoiceRecorderFactory(
            supported:
                !kIsWeb &&
                (defaultTargetPlatform == TargetPlatform.android ||
                    defaultTargetPlatform == TargetPlatform.iOS),
            // AVAudioRecorder metering on iOS can report normal speech below
            // the Android-calibrated cutoff even while producing valid audio.
            // Let the transcription service decide whether a non-empty iOS
            // take contains speech instead of rejecting it locally.
            silenceThresholdRms: defaultTargetPlatform == TargetPlatform.iOS
                ? null
                : 0.008,
            clock: ref.watch(appClockProvider),
          ),
        ),
        followupRepositoryProvider.overrideWith((ref) {
          final session = ref.watch(authControllerProvider).session;
          if (session == null) {
            throw StateError('An authenticated session is required.');
          }
          return DefaultFollowupRepository(
            database: ref.watch(appDatabaseProvider),
            apiUrl: config.apiUrl,
            token: session.token,
            dio: ref.watch(overseerHttpClientProvider),
            clock: ref.watch(appClockProvider),
          );
        }),
        newSessionRepositoryProvider.overrideWith((ref) {
          final session = ref.watch(authControllerProvider).session;
          if (session == null) {
            throw StateError('An authenticated session is required.');
          }
          return DefaultNewSessionRepository(
            database: ref.watch(appDatabaseProvider),
            apiUrl: config.apiUrl,
            token: session.token,
            dio: ref.watch(overseerHttpClientProvider),
            clock: ref.watch(appClockProvider),
          );
        }),
        liveProjectionSinkProvider.overrideWith(
          (ref) => ref.watch(sessionRepositoryProvider),
        ),
        attentionProjectionSinkProvider.overrideWith(
          (ref) =>
              ref.watch(sessionRepositoryProvider) as AttentionProjectionSink,
        ),
        projectLiveProjectionSinkProvider.overrideWith(
          (ref) => ref.watch(projectRepositoryProvider),
        ),
        authRepositoryProvider.overrideWith(
          (ref) => createOverseerAuthRepository(
            config: config,
            connection: connection,
          ),
        ),
        soundPreferenceStoreProvider.overrideWithValue(
          SharedPreferencesSoundPreferenceStore(),
        ),
        soundPreviewPlayerProvider.overrideWith((ref) {
          final player = AudioplayersSoundPreviewPlayer();
          ref.onDispose(() => player.dispose());
          return player;
        }),
        workSoundPlayerProvider.overrideWith((ref) {
          final player = AudioplayersWorkSoundPlayer();
          ref.onDispose(() => player.dispose());
          return player;
        }),
        fleetRepositoryProvider.overrideWith((ref) {
          final session = ref.watch(authControllerProvider).session;
          if (session == null) {
            throw StateError('An authenticated session is required.');
          }
          return DioFleetRepository(
            database: ref.watch(appDatabaseProvider),
            apiUrl: config.apiUrl,
            token: session.token,
            dio: ref.watch(overseerHttpClientProvider),
            clock: ref.watch(appClockProvider),
          );
        }),
        fleetLiveServiceProvider.overrideWith((ref) {
          final session = ref.watch(authControllerProvider).session;
          if (session == null) return null;
          return WebSocketFleetLiveService(
            serverUrl: config.serverUrl,
            apiUrl: config.apiUrl,
            token: session.token,
            dio: ref.watch(overseerHttpClientProvider),
            clock: ref.watch(appClockProvider),
            scheduler: ref.watch(appSchedulerProvider),
            diagnostics: ref.watch(appDiagnosticsProvider),
          );
        }),
        transcriptLiveServiceProvider.overrideWith((ref) {
          final live = ref.watch(fleetLiveServiceProvider);
          return live is TranscriptLiveService
              ? live as TranscriptLiveService
              : null;
        }),
      ],
      child: LiveSyncLifecycle(
        child: PushNotificationLifecycle(
          child: _AuthenticationSuccessListener(
            onAuthenticated: onAuthenticated,
            child: child,
          ),
        ),
      ),
    );
  }
}

class _AuthenticationSuccessListener extends ConsumerWidget {
  const _AuthenticationSuccessListener({
    required this.onAuthenticated,
    required this.child,
  });

  final VoidCallback? onAuthenticated;
  final Widget child;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    ref.listen<AuthState>(authControllerProvider, (previous, next) {
      if (previous?.phase != AuthPhase.authenticated &&
          next.phase == AuthPhase.authenticated) {
        onAuthenticated?.call();
      }
    });
    return child;
  }
}
