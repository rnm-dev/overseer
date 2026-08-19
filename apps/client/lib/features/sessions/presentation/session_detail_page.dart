import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;
import 'dart:ui';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:image_picker/image_picker.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../core/live/active_sessions.dart';
import '../../../core/live/presence.dart';
import '../../../core/config/app_config.dart';
import '../../fleet/application/fleet_controller.dart';
import '../../fleet/application/fleet_live_service.dart';
import '../../inquiries/application/plugin_inquiry_controller.dart';
import '../../inquiries/domain/plugin_inquiry.dart';
import '../../inquiries/domain/plugin_inquiry_repository.dart';
import '../../inquiries/inquiries.dart';
import '../../../shared/design/colors.dart';
import '../../../shared/design/motion.dart';
import '../../../shared/design/typography.dart';
import '../../../shared/widgets/app_button.dart';
import '../../../shared/widgets/app_bottom_sheet.dart';
import '../../../shared/widgets/app_navigation_bar.dart';
import '../../../shared/widgets/presence_stack.dart';
import '../../auth/application/auth_controller.dart';
import '../../auth/domain/auth_models.dart';
import '../../projects/application/projects_controller.dart';
import '../../projects/domain/project_models.dart';
import '../../projects/projects.dart';
import '../../settings/application/sound_pack_controller.dart';
import '../../settings/domain/sound_pack.dart';
import '../../settings/domain/work_sound_player.dart';
import '../../themes/app_theme_package.dart';
import '../application/attachment_clipboard_provider.dart';
import '../application/session_details_controller.dart';
import '../application/session_composer_controller.dart';
import '../application/session_file_controller.dart';
import '../application/sessions_controller.dart';
import '../application/transcript_controller.dart';
import '../application/voice_dictation_controller.dart';
import '../domain/followup_repository.dart';
import '../domain/file_link_transformer.dart';
import '../domain/new_session_repository.dart';
import '../domain/pasted_text.dart';
import '../domain/session_models.dart';
import 'session_composer.dart';
import 'session_file_viewer_page.dart';
import 'transcript_item_view.dart';
import 'transcript_items.dart';
import 'voice_input_alert_sheet.dart';
part 'session_detail_attachments.dart';
part 'session_detail_transcript.dart';

class SessionDetailPage extends ConsumerStatefulWidget {
  const SessionDetailPage({super.key, required this.session})
    : workspaceId = null,
      peonId = null,
      projectKey = null;

  const SessionDetailPage.newSession({
    super.key,
    required this.workspaceId,
    required this.peonId,
    this.projectKey,
  }) : session = null;

  final SessionSummary? session;
  final String? workspaceId;
  final String? peonId;
  final String? projectKey;

  @override
  ConsumerState<SessionDetailPage> createState() => _SessionDetailPageState();
}

abstract class _SessionDetailAttachmentHost
    extends ConsumerState<SessionDetailPage> {
  String get workspaceId;
  String get peonId;
  SessionSummary? get session;
  // Accessed by the attachment-method mixin through this host contract.
  // ignore: unused_element
  bool get _readingAttachments;
  set _readingAttachments(bool value);
  // ignore: unused_element
  String? get _attachmentError;
  set _attachmentError(String? value);
  List<NewSessionAttachment> get _composerAttachments;
  set _composerAttachments(List<NewSessionAttachment> value);
}

class _SessionDetailPageState extends _SessionDetailAttachmentHost
    with WidgetsBindingObserver, _SessionDetailAttachmentMethods {
  late final FleetLiveService? _live;
  late final TextEditingController _composerController;
  late SessionSummary? _session;
  final GlobalKey _composerMeasureKey = GlobalKey();
  bool _composerMeasurementScheduled = false;
  bool _syncingComposer = false;
  bool _stopping = false;

  // The composer resizes as the operator types. Only the body's bottom padding
  // depends on that, so it is published rather than held in page state: a
  // setState here would rebuild the transcript for a line of text.
  final ValueNotifier<double> _composerHeight = ValueNotifier<double>(0);
  String? _stopError;
  String? _locallyStoppedSessionId;
  @override
  List<NewSessionAttachment> _composerAttachments = const [];
  @override
  String? _attachmentError;
  @override
  bool _readingAttachments = false;
  bool _startingSession = false;
  bool _backgrounded = false;
  bool _presenceRestored = false;
  String? _selectedProjectKey;
  FollowupScope? _activeComposerScope;

  static const _newSessionDraftId = 'new-session';

  @override
  SessionSummary? get session => _session;
  @override
  String get workspaceId => session?.workspaceId ?? widget.workspaceId!;
  @override
  String get peonId => session?.peonId ?? widget.peonId!;

  @override
  void initState() {
    super.initState();
    _session = widget.session;
    _selectedProjectKey = widget.projectKey;
    _composerController = TextEditingController();
    _composerController.addListener(_handleComposerChanged);
    WidgetsBinding.instance.addObserver(this);
    _live = ref.read(fleetLiveServiceProvider);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      _live?.setPresence(
        workspaceId: workspaceId,
        location: session == null
            ? PresenceLocation.peon(peonId: peonId)
            : PresenceLocation.session(
                peonId: peonId,
                sessionId: session!.sessionId,
              ),
      );
    });
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _restorePeonPresence();
    _composerController.dispose();
    _composerHeight.dispose();
    super.dispose();
  }

  void _restorePeonPresence() {
    if (_presenceRestored) return;
    _presenceRestored = true;
    _live?.setPresence(
      workspaceId: workspaceId,
      location: PresenceLocation.peon(peonId: peonId),
    );
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      if (!_backgrounded) return;
      _backgrounded = false;
      final currentSession = session;
      if (currentSession == null) return;
      final scope = TranscriptScope(
        workspaceId: currentSession.workspaceId,
        peonId: currentSession.peonId,
        sessionId: currentSession.sessionId,
        isRunning: currentSession.isRunning,
      );
      ref.invalidate(
        sessionDetailsProvider(
          SessionDetailsScope(
            workspaceId: currentSession.workspaceId,
            peonId: currentSession.peonId,
            sessionId: currentSession.sessionId,
          ),
        ),
      );
      unawaited(
        ref
            .read(transcriptControllerProvider(scope).notifier)
            .resumeFromBackground(),
      );
      return;
    }
    if (state == AppLifecycleState.paused ||
        state == AppLifecycleState.hidden) {
      _backgrounded = true;
    }
    final scope = _activeComposerScope;
    if (scope == null) return;
    unawaited(
      ref
          .read(voiceDictationControllerProvider(scope).notifier)
          .cancel(
            message:
                'Recording was discarded when the app left the foreground.',
          ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final currentSession = session;
    final isNewSession = currentSession == null;
    final projectsScope = isNewSession
        ? ProjectsScope(workspaceId: workspaceId, peonId: peonId)
        : null;
    final projects = projectsScope == null
        ? null
        : ref.watch(projectsControllerProvider(projectsScope));
    final composerScope = FollowupScope(
      workspaceId: workspaceId,
      peonId: peonId,
      sessionId: currentSession?.sessionId ?? _newSessionDraftId,
    );
    _activeComposerScope = composerScope;
    final dictationProvider = voiceDictationControllerProvider(composerScope);
    final dictation = ref.watch(dictationProvider);
    ref.listen(dictationProvider, (previous, next) {
      if (next.completionId != previous?.completionId &&
          next.completedText != null) {
        _insertDictation(next.completedText!);
      }
      if (next.error != null &&
          (next.error != previous?.error ||
              next.canOpenSettings != previous?.canOpenSettings)) {
        final message = next.error!;
        final canOpenSettings = next.canOpenSettings;
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (!mounted) return;
          ref.read(dictationProvider.notifier).clearError();
          unawaited(
            showVoiceInputAlertSheet(
              context: context,
              message: message,
              canOpenSettings: canOpenSettings,
              openSettings: () =>
                  ref.read(dictationProvider.notifier).openSettings(),
            ),
          );
        });
      }
    });
    final transcriptScope = currentSession == null
        ? null
        : TranscriptScope(
            workspaceId: workspaceId,
            peonId: peonId,
            sessionId: currentSession.sessionId,
            isRunning: currentSession.isRunning,
          );
    final transcript = transcriptScope == null
        ? null
        : ref.watch(transcriptControllerProvider(transcriptScope));
    final fleet = ref.watch(fleetControllerProvider).value;
    final currentPeon = fleet
        ?.where((workspace) => workspace.workspace.id == workspaceId)
        .expand((workspace) => workspace.peons)
        .where((candidate) => candidate.id == peonId)
        .firstOrNull;
    final inquiryScope = currentSession == null
        ? null
        : PluginInquiryScope(
            workspaceId: workspaceId,
            peonId: peonId,
            sessionId: currentSession.sessionId,
            supported:
                currentPeon?.capabilities.contains(
                  'managed-plugin-inquiry-v1',
                ) ??
                false,
            online: currentPeon?.online ?? false,
          );
    final inquiries = inquiryScope == null
        ? null
        : ref.watch(pluginInquiryControllerProvider(inquiryScope));
    final composer = ref.watch(
      sessionComposerControllerProvider(composerScope),
    );
    final composerState = composer.value;
    if (!_startingSession &&
        composerState != null &&
        composerState.draft != _composerController.text) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted || composerState.draft == _composerController.text) {
          return;
        }
        _syncingComposer = true;
        _composerController.value = TextEditingValue(
          text: composerState.draft,
          selection: TextSelection.collapsed(
            offset: composerState.draft.length,
          ),
        );
        _syncingComposer = false;
      });
    }
    final details = currentSession == null
        ? null
        : ref
                  .watch(
                    sessionDetailsProvider(
                      SessionDetailsScope(
                        workspaceId: workspaceId,
                        peonId: peonId,
                        sessionId: currentSession.sessionId,
                      ),
                    ),
                  )
                  .value ??
              _detailsFromTranscript(transcript?.value?.events);
    final agentOverridden = composerState?.agent != null;
    final viewers = currentSession == null
        ? const <PresenceViewer>[]
        : ref.watch(
            presenceProvider.select(
              (presence) => presence.viewersForSession(
                workspaceId: workspaceId,
                peonId: peonId,
                sessionId: currentSession.sessionId,
              ),
            ),
          );
    final activeWorkspace = currentSession == null
        ? null
        : ref.watch(
            activeSessionsProvider.select(
              (state) => state.forWorkspace(workspaceId),
            ),
          );
    final reportedRunning = currentSession == null
        ? false
        : activeWorkspace?.contains(
                peonId: peonId,
                sessionId: currentSession.sessionId,
              ) ??
              transcript?.value?.isRunning ??
              (details?.status == 'running' || currentSession.isRunning);
    final isRunning =
        (reportedRunning || (composerState?.queue.isNotEmpty ?? false)) &&
        _locallyStoppedSessionId != currentSession?.sessionId;
    if (!reportedRunning &&
        currentSession != null &&
        _locallyStoppedSessionId == currentSession.sessionId) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && _locallyStoppedSessionId == currentSession.sessionId) {
          setState(() => _locallyStoppedSessionId = null);
        }
      });
    }
    final queueActions = _QueueActionSets.of(composerState?.queueActions);
    final headerSession =
        currentSession ??
        SessionSummary(
          workspaceId: workspaceId,
          peonId: peonId,
          sessionId: _newSessionDraftId,
          projectKey: _selectedProjectKey,
          title: 'New session',
          syncedAt: 0,
        );
    _scheduleComposerMeasurement();
    return Scaffold(
      key: const Key('session-detail-page'),
      body: SafeArea(
        top: false,
        child: Column(
          children: [
            _SessionHeader(
              session: headerSession,
              details: details,
              isNewSession: isNewSession,
              onBack: () {
                _restorePeonPresence();
                Navigator.of(context).maybePop();
              },
            ),
            Expanded(
              child: Stack(
                fit: StackFit.expand,
                children: [
                  if (isNewSession)
                    _NewSessionBody(
                      projects: projects!,
                      selectedProjectKey: _selectedProjectKey,
                      composerHeight: _composerHeight,
                      onProjectSelected: (projectKey) {
                        if (_startingSession ||
                            _selectedProjectKey == projectKey) {
                          return;
                        }
                        _resetSubmissionIdentity();
                        setState(() => _selectedProjectKey = projectKey);
                      },
                      onRetry: () => ref
                          .read(
                            projectsControllerProvider(projectsScope!).notifier,
                          )
                          .refresh(),
                    )
                  else
                    _TranscriptBody(
                      transcript: transcript!,
                      inquiries: inquiries!,
                      inquiryOnline: inquiryScope!.online,
                      onInquiryInstall: (inquiry) => ref
                          .read(
                            pluginInquiryControllerProvider(
                              inquiryScope,
                            ).notifier,
                          )
                          .respond(inquiry, PluginInquiryDecision.install),
                      onInquiryCancel: (inquiry) => ref
                          .read(
                            pluginInquiryControllerProvider(
                              inquiryScope,
                            ).notifier,
                          )
                          .respond(inquiry, PluginInquiryDecision.cancel),
                      ghost: _visibleGhost(composerState, transcript.value),
                      operator: ref.watch(authControllerProvider).session?.user,
                      viewers: viewers,
                      composerHeight: _composerHeight,
                      showWorking: isRunning,
                      stopping: _stopping,
                      stopError: _stopError,
                      onStop: () => _stopSession(transcriptScope!),
                      onRefresh: () => ref
                          .read(
                            transcriptControllerProvider(
                              transcriptScope!,
                            ).notifier,
                          )
                          .refresh(),
                      onLoadOlder: () => ref
                          .read(
                            transcriptControllerProvider(
                              transcriptScope!,
                            ).notifier,
                          )
                          .loadOlder(),
                      onOpenAttachment: _openTranscriptAttachment,
                      onOpenPreview: _openTranscriptPreview,
                      onOpenLink: (href) =>
                          _openTranscriptLink(href, details: details),
                    ),
                  Align(
                    alignment: Alignment.bottomCenter,
                    child: NotificationListener<SizeChangedLayoutNotification>(
                      onNotification: (_) {
                        _scheduleComposerMeasurement();
                        return false;
                      },
                      child: SizeChangedLayoutNotifier(
                        child: SizedBox(
                          key: _composerMeasureKey,
                          child: SessionComposer(
                            controller: _composerController,
                            enabled: composerState != null,
                            pending:
                                _readingAttachments ||
                                _startingSession ||
                                (composerState?.sending ?? false),
                            pendingLabel: _readingAttachments
                                ? 'Reading files…'
                                : _startingSession
                                ? 'Starting session…'
                                : submissionLabel(
                                    composerState,
                                    running: isRunning,
                                  ),
                            running: isRunning,
                            queuedCount: composerState?.pending.length ?? 0,
                            queuedItems: composerState?.queue ?? const [],
                            editingQueuedItems: queueActions.editing,
                            removingQueuedItems: queueActions.removing,
                            sendingQueuedItems: queueActions.sending,
                            error:
                                _attachmentError ??
                                composerState?.error ??
                                composerState?.queueError,
                            attachments: _composerAttachments,
                            providers:
                                composerState?.catalog?.providers ?? const [],
                            agent: composerState?.agent,
                            defaultAgent:
                                details?.agent ??
                                composerState?.catalog?.defaultAgent,
                            model: composerState?.model,
                            reasoningEffort: composerState?.reasoningEffort,
                            // What the composer falls back to with no override:
                            // the session's own pick, unless the operator has
                            // moved it to another agent, whose own default the
                            // sheet resolves for itself.
                            inheritedModel: agentOverridden
                                ? null
                                : details?.model,
                            inheritedReasoningEffort: agentOverridden
                                ? null
                                : details?.reasoningEffort,
                            allowAgentSelection: isNewSession,
                            onAgentChanged: (agent) => ref
                                .read(
                                  sessionComposerControllerProvider(
                                    composerScope,
                                  ).notifier,
                                )
                                .selectAgent(agent),
                            onModelChanged: (model) => ref
                                .read(
                                  sessionComposerControllerProvider(
                                    composerScope,
                                  ).notifier,
                                )
                                .selectModel(model),
                            onReasoningEffortChanged: (effort) => ref
                                .read(
                                  sessionComposerControllerProvider(
                                    composerScope,
                                  ).notifier,
                                )
                                .selectReasoningEffort(effort),
                            onAttach: _showAttachmentOptions,
                            onContentInserted: _insertKeyboardContent,
                            onLongTextPasted: _attachPastedText,
                            dictation: dictation,
                            onVoiceStart: () async {
                              final started = await ref
                                  .read(dictationProvider.notifier)
                                  .start();
                              if (started) {
                                await HapticFeedback.mediumImpact();
                              }
                            },
                            onVoiceStop: () {
                              unawaited(HapticFeedback.selectionClick());
                              unawaited(
                                ref.read(dictationProvider.notifier).stop(),
                              );
                            },
                            onVoiceCancel: () => unawaited(
                              ref.read(dictationProvider.notifier).cancel(),
                            ),
                            onRemoveAttachment: (index) {
                              ref
                                  .read(
                                    sessionComposerControllerProvider(
                                      composerScope,
                                    ).notifier,
                                  )
                                  .resetSubmissionIdentity();
                              setState(() {
                                _composerAttachments = [
                                  ..._composerAttachments.take(index),
                                  ..._composerAttachments.skip(index + 1),
                                ];
                                _attachmentError = null;
                              });
                            },
                            onSubmit: () => isNewSession
                                ? _startSession(composerScope)
                                : _submitComposer(composerScope),
                            onRemoveQueued: (itemId) => ref
                                .read(
                                  sessionComposerControllerProvider(
                                    composerScope,
                                  ).notifier,
                                )
                                .removeQueued(itemId),
                            onEditQueued: (itemId, prompt) => ref
                                .read(
                                  sessionComposerControllerProvider(
                                    composerScope,
                                  ).notifier,
                                )
                                .editQueued(itemId, prompt),
                            onSteerQueued: (itemId) => ref
                                .read(
                                  sessionComposerControllerProvider(
                                    composerScope,
                                  ).notifier,
                                )
                                .steerQueued(itemId),
                          ),
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  void _measureComposer() {
    if (!mounted) return;
    final renderBox =
        _composerMeasureKey.currentContext?.findRenderObject() as RenderBox?;
    if (renderBox == null || !renderBox.hasSize) return;
    final height = renderBox.size.height;
    if ((height - _composerHeight.value).abs() < 0.5) return;
    _composerHeight.value = height;
  }

  /// The ghost is shown until the transcript grows past the count its send
  /// captured. Nothing is matched by payload: the row that retires it need not
  /// be the ghost's own, and it is never rendered as a transcript row.
  static ComposerGhost? _visibleGhost(
    SessionComposerState? composer,
    TranscriptState? transcript,
  ) {
    final ghost = composer?.ghost;
    if (ghost == null) return null;
    return ghost.visibleAgainst(
          transcript?.userMessageCount ?? 0,
          queuedCommandIds:
              composer?.queue.map((item) => item.commandId) ?? const [],
        )
        ? ghost
        : null;
  }

  void _insertDictation(String transcript) {
    if (!mounted || transcript.trim().isEmpty) return;
    _composerController.value = insertVoiceTranscript(
      _composerController.value,
      transcript,
    );
  }

  void _scheduleComposerMeasurement() {
    if (_composerMeasurementScheduled) return;
    _composerMeasurementScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _composerMeasurementScheduled = false;
      _measureComposer();
    });
  }

  void _handleComposerChanged() {
    if (_syncingComposer || !mounted) return;
    // No setState: the composer listens to this controller itself, and the
    // draft update below rebuilds whatever else depends on the text.
    final scope = FollowupScope(
      workspaceId: workspaceId,
      peonId: peonId,
      sessionId: session?.sessionId ?? _newSessionDraftId,
    );
    ref
        .read(sessionComposerControllerProvider(scope).notifier)
        .updateDraft(_composerController.text);
  }

  Future<void> _submitComposer(
    FollowupScope scope, {
    bool startNow = false,
  }) async {
    final transcriptScope = TranscriptScope(
      workspaceId: workspaceId,
      peonId: peonId,
      sessionId: session!.sessionId,
      isRunning: session!.isRunning,
    );
    final running =
        ref
            .read(transcriptControllerProvider(transcriptScope))
            .value
            ?.isRunning ??
        session!.isRunning;
    final submitted = await ref
        .read(sessionComposerControllerProvider(scope).notifier)
        .submit(
          running: running,
          startNow: startNow,
          attachments: _composerAttachments,
          transcriptUserMessages:
              ref
                  .read(transcriptControllerProvider(transcriptScope))
                  .value
                  ?.userMessageCount ??
              0,
        );
    if (submitted && (!running || startNow)) {
      unawaited(
        ref
            .read(transcriptControllerProvider(transcriptScope).notifier)
            .refreshAfterSubmission(),
      );
    }
    if (mounted && submitted) {
      setState(() {
        _composerAttachments = const [];
        _attachmentError = null;
      });
    }
    if (mounted && submitted && _locallyStoppedSessionId != null) {
      setState(() => _locallyStoppedSessionId = null);
    }
    if (mounted && submitted && (!running || startNow)) {
      _playWorkCue(WorkSoundCue.start);
    }
  }

  Future<void> _stopSession(TranscriptScope transcriptScope) async {
    final currentSession = session;
    if (currentSession == null || _stopping) return;
    setState(() {
      _stopping = true;
      _stopError = null;
    });
    final transcriptController = ref.read(
      transcriptControllerProvider(transcriptScope).notifier,
    );
    transcriptController.suppressNextCompletionSound();
    try {
      await ref
          .read(sessionRepositoryProvider)
          .cancelSession(
            workspaceId: workspaceId,
            peonId: peonId,
            sessionId: currentSession.sessionId,
          );
      if (!mounted) return;
      setState(() {
        _stopping = false;
        _locallyStoppedSessionId = currentSession.sessionId;
      });
      unawaited(ref.read(workSoundPlayerProvider).stop());
      _playWorkCue(WorkSoundCue.stop);
      unawaited(
        ref
            .read(transcriptControllerProvider(transcriptScope).notifier)
            .refresh(),
      );
    } on SessionsException catch (error) {
      transcriptController.restoreCompletionSound();
      if (!mounted) return;
      setState(() {
        _stopping = false;
        _stopError = error.message;
      });
    } catch (_) {
      transcriptController.restoreCompletionSound();
      if (!mounted) return;
      setState(() {
        _stopping = false;
        _stopError = 'Could not stop this session.';
      });
    }
  }

  void _openTranscriptAttachment(TranscriptAttachment attachment) {
    final currentSession = session;
    final path = attachment.path?.trim();
    if (currentSession == null || path == null || path.isEmpty) return;
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => SessionFileViewerPage(
          scope: SessionFileScope.attachment(
            workspaceId: currentSession.workspaceId,
            peonId: currentSession.peonId,
            sessionId: currentSession.sessionId,
            path: path,
            name: attachment.label,
            type: attachment.type,
          ),
        ),
      ),
    );
  }

  void _openTranscriptPreview(TranscriptPreviewItem preview) {
    final currentSession = session;
    if (currentSession == null) return;
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => SessionFileViewerPage(
          scope: SessionFileScope.artifact(
            workspaceId: currentSession.workspaceId,
            peonId: currentSession.peonId,
            sessionId: currentSession.sessionId,
            path: preview.path,
          ),
        ),
      ),
    );
  }

  Future<void> _openTranscriptLink(
    String href, {
    required SessionDetails? details,
  }) async {
    final currentSession = session;
    final target = href.trim();
    if (currentSession == null || target.isEmpty) return;

    const transformer = FileLinkTransformer();
    final projectId = details?.projectId?.trim();
    final projectRoot = details?.projectRoot?.trim();
    final projectKey = (details?.projectKey ?? currentSession.projectKey)
        ?.trim();
    if (projectId?.isNotEmpty == true &&
        projectRoot?.isNotEmpty == true &&
        projectKey?.isNotEmpty == true) {
      final projectFile = transformer.projectFile(
        target,
        ProjectFileLinkContext(
          peonId: currentSession.peonId,
          projectId: projectId!,
          projectRoot: projectRoot!,
          currentOrigin: ref.read(overseerServerUrlProvider)?.origin,
        ),
      );
      if (projectFile != null) {
        if (!mounted) return;
        await Navigator.of(context).push(
          MaterialPageRoute<void>(
            builder: (_) => ProjectFileViewerPage(
              workspaceId: currentSession.workspaceId,
              peonId: currentSession.peonId,
              projectId: projectId,
              projectKey: projectKey!,
              path: projectFile.relativePath,
            ),
          ),
        );
        return;
      }
    }

    final localPath = transformer.localFilePath(target);
    if (localPath != null) {
      if (!mounted) return;
      await Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => SessionFileViewerPage(
            scope: SessionFileScope.artifact(
              workspaceId: currentSession.workspaceId,
              peonId: currentSession.peonId,
              sessionId: currentSession.sessionId,
              path: localPath,
            ),
          ),
        ),
      );
      return;
    }

    final uri = Uri.tryParse(target);
    if (uri == null ||
        !const {'http', 'https', 'mailto'}.contains(uri.scheme)) {
      _showLinkError('This link type is not supported.');
      return;
    }
    try {
      final opened = await launchUrl(uri, mode: LaunchMode.externalApplication);
      if (!opened && mounted) _showLinkError('Could not open this link.');
    } catch (_) {
      if (mounted) _showLinkError('Could not open this link.');
    }
  }

  void _showLinkError(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  Future<void> _startSession(FollowupScope scope) async {
    if (_startingSession) return;
    setState(() => _startingSession = true);
    final created = await ref
        .read(sessionComposerControllerProvider(scope).notifier)
        .startSession(
          projectKey: _selectedProjectKey,
          attachments: _composerAttachments,
        );
    if (!mounted) return;
    if (created == null) {
      setState(() => _startingSession = false);
      return;
    }
    _playWorkCue(WorkSoundCue.start);
    await _warmCreatedSession(created);
    if (!mounted) return;
    _syncingComposer = true;
    _composerController.clear();
    _syncingComposer = false;
    setState(() {
      _session = created;
      _startingSession = false;
      _composerAttachments = const [];
      _attachmentError = null;
    });
    _live?.setPresence(
      workspaceId: created.workspaceId,
      location: PresenceLocation.session(
        peonId: created.peonId,
        sessionId: created.sessionId,
      ),
    );
  }

  void _playWorkCue(WorkSoundCue cue) {
    final pack =
        ref.read(soundPackControllerProvider).asData?.value ?? SoundPack.peon;
    unawaited(ref.read(workSoundPlayerProvider).playCue(pack, cue));
  }

  Future<void> _warmCreatedSession(SessionSummary created) async {
    final transcriptScope = TranscriptScope(
      workspaceId: created.workspaceId,
      peonId: created.peonId,
      sessionId: created.sessionId,
      isRunning: created.isRunning,
    );
    final composerScope = FollowupScope(
      workspaceId: created.workspaceId,
      peonId: created.peonId,
      sessionId: created.sessionId,
    );
    final transcriptProvider = transcriptControllerProvider(transcriptScope);
    final composerProvider = sessionComposerControllerProvider(composerScope);
    final transcriptSubscription = ref.listenManual(
      transcriptProvider,
      (_, _) {},
    );
    final composerSubscription = ref.listenManual(composerProvider, (_, _) {});
    try {
      await Future.wait<void>([
        _settleProvider(ref.read(transcriptProvider.future)),
        _settleProvider(ref.read(composerProvider.future)),
      ]);
    } finally {
      transcriptSubscription.close();
      composerSubscription.close();
    }
  }

  Future<void> _settleProvider(Future<Object?> future) async {
    try {
      await future;
    } catch (_) {
      // The destination surface owns its normal retryable error treatment.
    }
  }
}

/// The queued items each pending action applies to, read in one pass over the
/// queue instead of once per action.
class _QueueActionSets {
  const _QueueActionSets({
    required this.editing,
    required this.removing,
    required this.sending,
  });

  static const empty = _QueueActionSets(editing: {}, removing: {}, sending: {});

  static _QueueActionSets of(Map<String, QueuedFollowupAction>? actions) {
    if (actions == null || actions.isEmpty) return empty;
    final editing = <String>{};
    final removing = <String>{};
    final sending = <String>{};
    for (final entry in actions.entries) {
      switch (entry.value) {
        case QueuedFollowupAction.editing:
          editing.add(entry.key);
          break;
        case QueuedFollowupAction.removing:
          removing.add(entry.key);
          break;
        case QueuedFollowupAction.sending:
          sending.add(entry.key);
          break;
      }
    }
    return _QueueActionSets(
      editing: editing,
      removing: removing,
      sending: sending,
    );
  }

  final Set<String> editing;
  final Set<String> removing;
  final Set<String> sending;
}

class _NewSessionBody extends StatelessWidget {
  const _NewSessionBody({
    required this.projects,
    required this.selectedProjectKey,
    required this.composerHeight,
    required this.onProjectSelected,
    required this.onRetry,
  });

  final AsyncValue<ProjectsState> projects;
  final String? selectedProjectKey;
  final ValueListenable<double> composerHeight;
  final ValueChanged<String> onProjectSelected;
  final Future<void> Function() onRetry;

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<double>(
      valueListenable: composerHeight,
      builder: (context, bottomPadding, _) => LayoutBuilder(
        key: const Key('new-session-project-selection'),
        builder: (context, constraints) => SingleChildScrollView(
          key: const Key('new-session-project-scroll'),
          padding: EdgeInsets.fromLTRB(28, 32, 28, 24 + bottomPadding),
          child: ConstrainedBox(
            constraints: BoxConstraints(
              minHeight: math.max(
                0,
                constraints.maxHeight - 56 - bottomPadding,
              ),
            ),
            child: Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 430),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text(
                      'Select a project',
                      key: const Key('new-session-project-title'),
                      textAlign: TextAlign.center,
                      style: AppTypography.display(
                        fontSize: 22,
                        fontWeight: FontWeight.w700,
                        letterSpacing: -0.2,
                      ),
                    ),
                    const SizedBox(height: 8),
                    Text(
                      'Choose where this session should do its work.',
                      textAlign: TextAlign.center,
                      style: AppTypography.body(
                        fontSize: 13,
                        color: AppThemePalette.of(context).inkMuted,
                        height: 1.45,
                      ),
                    ),
                    const SizedBox(height: 22),
                    projects.when(
                      skipLoadingOnRefresh: true,
                      data: (state) => _ProjectSelectionContent(
                        state: state,
                        selectedProjectKey: selectedProjectKey,
                        onProjectSelected: onProjectSelected,
                        onRetry: onRetry,
                      ),
                      loading: () => Center(
                        child: SizedBox.square(
                          dimension: 22,
                          child: CircularProgressIndicator(
                            strokeWidth: 1.8,
                            color: AppThemePalette.of(context).accentStrong,
                          ),
                        ),
                      ),
                      error: (_, _) => _ProjectSelectionNotice(
                        message: 'Could not open the project cache.',
                        onRetry: onRetry,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _ProjectSelectionContent extends StatelessWidget {
  const _ProjectSelectionContent({
    required this.state,
    required this.selectedProjectKey,
    required this.onProjectSelected,
    required this.onRetry,
  });

  final ProjectsState state;
  final String? selectedProjectKey;
  final ValueChanged<String> onProjectSelected;
  final Future<void> Function() onRetry;

  @override
  Widget build(BuildContext context) {
    if (state.projects.isEmpty && state.isRefreshing) {
      return Center(
        child: SizedBox.square(
          dimension: 22,
          child: CircularProgressIndicator(
            strokeWidth: 1.8,
            color: AppThemePalette.of(context).accentStrong,
          ),
        ),
      );
    }
    if (state.projects.isEmpty) {
      return _ProjectSelectionNotice(
        message: state.message ?? 'No projects are available on this peon.',
        onRetry: onRetry,
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (state.message case final message?) ...[
          _ProjectSelectionNotice(message: message, onRetry: onRetry),
          const SizedBox(height: 10),
        ],
        for (var index = 0; index < state.projects.length; index++) ...[
          _ProjectSelectionRow(
            project: state.projects[index],
            selected: state.projects[index].key == selectedProjectKey,
            onTap: () => onProjectSelected(state.projects[index].key),
          ),
          if (index != state.projects.length - 1) const SizedBox(height: 8),
        ],
      ],
    );
  }
}

class _ProjectSelectionRow extends StatelessWidget {
  const _ProjectSelectionRow({
    required this.project,
    required this.selected,
    required this.onTap,
  });

  final PeonProject project;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      selected: selected,
      label: 'Select ${project.displayName}',
      child: Material(
        key: Key('new-session-project-${project.projectId}'),
        color: selected
            ? AppThemePalette.of(context).accent.withValues(alpha: 0.09)
            : AppThemePalette.of(context).surface,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(10),
          side: BorderSide(
            color: selected
                ? AppThemePalette.of(context).accent.withValues(alpha: 0.7)
                : AppThemePalette.of(context).surfaceHover,
          ),
        ),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 58),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              child: Row(
                children: [
                  Icon(
                    LucideIcons.folder,
                    size: 18,
                    color: selected
                        ? AppThemePalette.of(context).accentStrong
                        : AppThemePalette.of(context).inkFaint,
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          project.displayName,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: AppTypography.display(
                            fontSize: 13,
                            fontWeight: FontWeight.w600,
                            color: selected
                                ? AppThemePalette.of(context).ink
                                : AppThemePalette.of(context).inkMuted,
                          ),
                        ),
                        if (project.name?.trim().isNotEmpty == true &&
                            project.displayName != project.key) ...[
                          const SizedBox(height: 3),
                          Text(
                            project.key,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: AppTypography.mono(
                              fontSize: 9.5,
                              color: AppThemePalette.of(context).inkFaint,
                            ),
                          ),
                        ],
                      ],
                    ),
                  ),
                  const SizedBox(width: 12),
                  AnimatedContainer(
                    duration: const Duration(milliseconds: 160),
                    width: 20,
                    height: 20,
                    decoration: BoxDecoration(
                      color: selected
                          ? AppThemePalette.of(context).warning
                          : Colors.transparent,
                      shape: BoxShape.circle,
                      border: Border.all(
                        color: selected
                            ? AppThemePalette.of(context).warning
                            : AppThemePalette.of(context).surfaceActive,
                      ),
                    ),
                    alignment: Alignment.center,
                    child: selected
                        ? Icon(
                            LucideIcons.check,
                            size: 12,
                            color: AppThemePalette.of(context).onAccent,
                          )
                        : null,
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _ProjectSelectionNotice extends StatelessWidget {
  const _ProjectSelectionNotice({required this.message, required this.onRetry});

  final String message;
  final Future<void> Function() onRetry;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: AppThemePalette.of(context).surface,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: AppThemePalette.of(context).surfaceHover),
      ),
      child: Row(
        children: [
          Icon(
            LucideIcons.folderX,
            size: 17,
            color: AppThemePalette.of(context).inkFaint,
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              message,
              style: AppTypography.body(
                fontSize: 12,
                color: AppThemePalette.of(context).inkMuted,
              ),
            ),
          ),
          TextButton(onPressed: onRetry, child: const Text('Retry')),
        ],
      ),
    );
  }
}

class _SessionHeader extends StatelessWidget {
  const _SessionHeader({
    required this.session,
    required this.details,
    required this.onBack,
    this.isNewSession = false,
  });

  final SessionSummary session;
  final SessionDetails? details;
  final VoidCallback onBack;
  final bool isNewSession;

  @override
  Widget build(BuildContext context) {
    final projectKey = session.projectKey?.trim();
    final stats = _statsLabel(details);
    final theme = Theme.of(context);
    final subtitleColor =
        theme.extension<AppThemePalette>()?.package.inkFaint ??
        theme.colorScheme.onSurfaceVariant;
    return AppNavigationBar(
      key: const Key('session-navbar'),
      showBackButton: true,
      onBack: onBack,
      backButtonKey: const Key('session-back'),
      contentPadding: const EdgeInsets.fromLTRB(8, 10, 8, 6),
      left: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text.rich(
            key: const Key('session-title'),
            TextSpan(
              children: [
                if (projectKey?.isNotEmpty == true) ...[
                  TextSpan(
                    text: _titleize(projectKey!),
                    style: AppTypography.display(
                      fontSize: 14,
                      fontWeight: FontWeight.w600,
                      color: AppThemePalette.of(context).warning,
                    ),
                  ),
                  const TextSpan(text: '  '),
                ],
                TextSpan(text: session.displayTitle),
              ],
            ),
            maxLines: 1,
            overflow: TextOverflow.fade,
            softWrap: false,
            style: AppTypography.display(
              fontSize: 14,
              fontWeight: FontWeight.w600,
            ),
          ),
          SizedBox(
            key: const Key('session-stats-slot'),
            height: 12,
            child: stats == null
                ? const SizedBox.shrink()
                : Align(
                    alignment: Alignment.centerLeft,
                    child: Text(
                      stats,
                      key: const Key('session-stats'),
                      maxLines: 1,
                      overflow: TextOverflow.fade,
                      softWrap: false,
                      style: AppTypography.mono(
                        fontSize: 11,
                        color: subtitleColor,
                        height: 1,
                      ).copyWith(shadows: const []),
                    ),
                  ),
          ),
        ],
      ),
      right: isNewSession
          ? null
          : IconButton(
              key: const Key('session-files'),
              tooltip: 'Open project files',
              onPressed: () => context.pushNamed(
                'project-files',
                queryParameters: {
                  'workspaceId': session.workspaceId,
                  'peonId': session.peonId,
                  'projectKey': session.projectKey,
                  'projectId': session.projectId,
                },
              ),
              padding: EdgeInsets.zero,
              constraints: const BoxConstraints.tightFor(width: 36, height: 40),
              style: IconButton.styleFrom(
                minimumSize: const Size(36, 40),
                tapTargetSize: MaterialTapTargetSize.shrinkWrap,
              ),
              icon: Icon(
                LucideIcons.folderTree,
                size: 18,
                color: AppThemePalette.of(context).inkMuted,
              ),
            ),
    );
  }
}

String? _statsLabel(SessionDetails? details) {
  if (details == null) return null;
  final usage = details.usage;
  final parts = <String>[
    if (details.turnCount > 0)
      '${details.turnCount} ${details.turnCount == 1 ? 'turn' : 'turns'}',
    if (usage != null) '${_compactNumber(usage.inputTokens)} input',
    if (usage != null && usage.outputTokens > 0)
      '${_compactNumber(usage.outputTokens)} output',
  ];
  return parts.isEmpty ? null : parts.join('·');
}

SessionDetails? _detailsFromTranscript(List<TranscriptEvent>? events) {
  if (events == null) return null;
  var turnCount = 0;
  SessionUsage? usage;
  for (final event in events) {
    if (event.type != 'result') continue;
    final payload = event.payload;
    turnCount += (payload['num_turns'] as num?)?.toInt() ?? 0;
    final rawUsage = payload['usage'];
    if (rawUsage is! Map) continue;
    int tokens(String camelCase, String snakeCase) =>
        (rawUsage[camelCase] as num? ?? rawUsage[snakeCase] as num?)?.toInt() ??
        0;
    usage = SessionUsage(
      inputTokens: tokens('inputTokens', 'input_tokens'),
      outputTokens: tokens('outputTokens', 'output_tokens'),
      cacheCreationInputTokens: tokens(
        'cacheCreationInputTokens',
        'cache_creation_input_tokens',
      ),
      cacheReadInputTokens: tokens(
        'cacheReadInputTokens',
        'cache_read_input_tokens',
      ),
    );
  }
  if (turnCount == 0 && usage == null) return null;
  return SessionDetails(turnCount: turnCount, usage: usage);
}

String _compactNumber(int value) {
  if (value < 1000) return '$value';
  if (value < 1000000) {
    final compact = value / 1000;
    return '${compact >= 10 ? compact.toStringAsFixed(0) : compact.toStringAsFixed(1)}K'
        .replaceFirst('.0K', 'K');
  }
  final compact = value / 1000000;
  return '${compact >= 10 ? compact.toStringAsFixed(0) : compact.toStringAsFixed(1)}M'
      .replaceFirst('.0M', 'M');
}

String _titleize(String value) {
  return value
      .split(RegExp(r'[-_\s]+'))
      .where((part) => part.isNotEmpty)
      .map((part) => '${part[0].toUpperCase()}${part.substring(1)}')
      .join(' ');
}
