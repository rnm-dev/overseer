import 'dart:async';
import 'dart:math' as math;
import 'dart:ui';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../../../core/live/presence.dart';
import '../../fleet/application/fleet_controller.dart';
import '../../fleet/application/fleet_live_service.dart';
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
import '../../settings/application/sound_pack_controller.dart';
import '../../settings/domain/sound_pack.dart';
import '../../settings/domain/work_sound_player.dart';
import '../application/attachment_clipboard_provider.dart';
import '../application/session_details_controller.dart';
import '../application/session_composer_controller.dart';
import '../application/session_file_controller.dart';
import '../application/sessions_controller.dart';
import '../application/transcript_controller.dart';
import '../application/voice_dictation_controller.dart';
import '../domain/followup_repository.dart';
import '../domain/new_session_repository.dart';
import '../domain/session_models.dart';
import 'session_composer.dart';
import 'session_file_viewer_page.dart';
import 'transcript_item_view.dart';
import 'transcript_items.dart';
import 'voice_input_alert_sheet.dart';

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

class _SessionDetailPageState extends ConsumerState<SessionDetailPage>
    with WidgetsBindingObserver {
  late final FleetLiveService? _live;
  late final TextEditingController _composerController;
  late SessionSummary? _session;
  final GlobalKey _composerMeasureKey = GlobalKey();
  bool _composerMeasurementScheduled = false;
  bool _syncingComposer = false;
  bool _stopping = false;
  double _composerHeight = 0;
  String? _stopError;
  String? _locallyStoppedSessionId;
  List<NewSessionAttachment> _composerAttachments = const [];
  String? _attachmentError;
  bool _readingAttachments = false;
  bool _startingSession = false;
  bool _backgrounded = false;
  String? _selectedProjectKey;
  FollowupScope? _activeComposerScope;

  static const _newSessionDraftId = 'new-session';

  SessionSummary? get session => _session;
  String get workspaceId => session?.workspaceId ?? widget.workspaceId!;
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
    _live?.setPresence(
      workspaceId: workspaceId,
      location: PresenceLocation.peon(peonId: peonId),
    );
    _composerController.dispose();
    super.dispose();
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
    final modelProvider = _modelProviderFor(
      composerState?.catalog,
      agent: composerState?.agent ?? details?.agent,
      model: composerState?.model ?? details?.model,
    );
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
    final reportedRunning =
        transcript?.value?.isRunning ??
        (details?.status == 'running' || (currentSession?.isRunning ?? false));
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
            ),
            Expanded(
              child: Stack(
                fit: StackFit.expand,
                children: [
                  if (isNewSession)
                    Padding(
                      padding: EdgeInsets.only(bottom: _composerHeight),
                      child: _NewSessionBody(
                        projects: projects!,
                        selectedProjectKey: _selectedProjectKey,
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
                              projectsControllerProvider(
                                projectsScope!,
                              ).notifier,
                            )
                            .refresh(),
                      ),
                    )
                  else
                    _TranscriptBody(
                      transcript: transcript!,
                      operator: ref.watch(authControllerProvider).session?.user,
                      viewers: viewers,
                      bottomPadding: math.max(24, _composerHeight + 4),
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
                                : _submissionLabel(
                                    composerState,
                                    running: isRunning,
                                  ),
                            running: isRunning,
                            queuedCount: composerState?.pending.length ?? 0,
                            queuedItems: composerState?.queue ?? const [],
                            editingQueuedItems:
                                composerState?.queueActions.entries
                                    .where(
                                      (entry) =>
                                          entry.value ==
                                          QueuedFollowupAction.editing,
                                    )
                                    .map((entry) => entry.key)
                                    .toSet() ??
                                const {},
                            removingQueuedItems:
                                composerState?.queueActions.entries
                                    .where(
                                      (entry) =>
                                          entry.value ==
                                          QueuedFollowupAction.removing,
                                    )
                                    .map((entry) => entry.key)
                                    .toSet() ??
                                const {},
                            sendingQueuedItems:
                                composerState?.queueActions.entries
                                    .where(
                                      (entry) =>
                                          entry.value ==
                                          QueuedFollowupAction.sending,
                                    )
                                    .map((entry) => entry.key)
                                    .toSet() ??
                                const {},
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
                            defaultModelLabel: _catalogLabel(
                              modelProvider?.models,
                              agentOverridden ? null : details?.model,
                              fallback: 'Default',
                            ),
                            defaultReasoningEffortLabel: _catalogLabel(
                              modelProvider?.reasoningEfforts,
                              agentOverridden ? null : details?.reasoningEffort,
                              fallback: 'Default',
                            ),
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
                            onStopAndRun: () =>
                                _submitComposer(composerScope, startNow: true),
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
                            onSendQueuedNow: (itemId) => ref
                                .read(
                                  sessionComposerControllerProvider(
                                    composerScope,
                                  ).notifier,
                                )
                                .sendQueuedNow(itemId),
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
    if ((height - _composerHeight).abs() < 0.5) return;
    setState(() => _composerHeight = height);
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
    setState(() {});
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
        );
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

  Future<void> _pickAttachments() async {
    const maxFiles = 10;
    const maxBytes = 25 * 1024 * 1024;
    setState(() {
      _readingAttachments = true;
      _attachmentError = null;
    });
    try {
      final result = await FilePicker.pickFiles(
        allowMultiple: true,
        withData: false,
      );
      if (!mounted || result == null) return;
      final selected = <NewSessionAttachment>[];
      var rejectedLargeFiles = 0;
      var rejectedExtraFiles = 0;
      final available = maxFiles - _composerAttachments.length;
      for (final file in result.files) {
        if (file.size > maxBytes) {
          rejectedLargeFiles++;
          continue;
        }
        if (selected.length >= available) {
          rejectedExtraFiles++;
          continue;
        }
        final bytes = file.bytes ?? await file.xFile.readAsBytes();
        selected.add(
          NewSessionAttachment(
            name: file.name,
            type: _isImageName(file.name) ? 'image' : 'file',
            bytes: bytes,
          ),
        );
      }
      final errors = <String>[
        if (rejectedLargeFiles > 0)
          '$rejectedLargeFiles '
              '${rejectedLargeFiles == 1 ? 'file is' : 'files are'} larger than 25 MB.',
        if (rejectedExtraFiles > 0)
          'You can attach up to 10 files; '
              '$rejectedExtraFiles ${rejectedExtraFiles == 1 ? 'file was' : 'files were'} not added.',
      ];
      if (selected.isNotEmpty) _resetSubmissionIdentity();
      setState(() {
        _composerAttachments = [..._composerAttachments, ...selected];
        _attachmentError = errors.isEmpty ? null : errors.join(' ');
      });
    } catch (_) {
      if (!mounted) return;
      setState(() => _attachmentError = 'Files could not be selected.');
    } finally {
      if (mounted) {
        setState(() {
          _readingAttachments = false;
        });
      }
    }
  }

  Future<void> _showAttachmentOptions() {
    return showAppBottomSheet<void>(
      context: context,
      builder: (sheetContext) => AppBottomSheet(
        title: 'Add attachments',
        handleKey: const Key('session-attachment-sheet-handle'),
        children: [
          _AttachmentOption(
            key: const Key('session-attachment-choose-files'),
            icon: LucideIcons.folderOpen,
            title: 'Choose files',
            subtitle: 'Up to 10 files, 25 MB each',
            onTap: () {
              Navigator.of(sheetContext).pop();
              unawaited(_pickAttachments());
            },
          ),
          const SizedBox(height: 8),
          _AttachmentOption(
            key: const Key('session-attachment-paste'),
            icon: LucideIcons.clipboardPaste,
            title: 'Paste from clipboard',
            subtitle: 'Images and copied files',
            onTap: () {
              Navigator.of(sheetContext).pop();
              unawaited(_pasteAttachments());
            },
          ),
        ],
      ),
    );
  }

  Future<void> _pasteAttachments() async {
    const maxFiles = 10;
    const maxBytes = 25 * 1024 * 1024;
    setState(() {
      _readingAttachments = true;
      _attachmentError = null;
    });
    try {
      final result = await ref
          .read(attachmentClipboardProvider)
          .read(
            availableFiles: maxFiles - _composerAttachments.length,
            maxBytes: maxBytes,
          );
      if (!mounted) return;
      final errors = _attachmentLimitErrors(
        skippedTooLarge: result.skippedTooLarge,
        skippedForLimit: result.skippedForLimit,
      );
      if (result.attachments.isNotEmpty) {
        _resetSubmissionIdentity();
      }
      setState(() {
        _composerAttachments = [
          ..._composerAttachments,
          for (final attachment in result.attachments)
            NewSessionAttachment(
              name: attachment.name,
              type: attachment.type,
              bytes: attachment.bytes,
            ),
        ];
        _attachmentError = result.attachments.isEmpty && errors.isEmpty
            ? 'The clipboard does not contain an image or file.'
            : errors.isEmpty
            ? null
            : errors.join(' ');
      });
    } catch (_) {
      if (!mounted) return;
      setState(
        () => _attachmentError = 'Clipboard contents could not be pasted.',
      );
    } finally {
      if (mounted) {
        setState(() {
          _readingAttachments = false;
        });
      }
    }
  }

  void _insertKeyboardContent(KeyboardInsertedContent content) {
    const maxFiles = 10;
    const maxBytes = 25 * 1024 * 1024;
    final bytes = content.data;
    if (bytes == null || bytes.isEmpty) {
      final uri = content.uri;
      if (uri.isEmpty) {
        setState(
          () => _attachmentError = 'The pasted image could not be read.',
        );
        return;
      }
      unawaited(
        _insertKeyboardUriContent(
          uri: uri,
          mimeType: content.mimeType,
          maxBytes: maxBytes,
        ),
      );
      return;
    }
    final errors = _attachmentLimitErrors(
      skippedTooLarge: bytes.length > maxBytes ? 1 : 0,
      skippedForLimit: _composerAttachments.length >= maxFiles ? 1 : 0,
    );
    if (errors.isNotEmpty) {
      setState(() => _attachmentError = errors.join(' '));
      return;
    }
    final extension = switch (content.mimeType) {
      'image/jpeg' => 'jpg',
      'image/gif' => 'gif',
      'image/webp' => 'webp',
      _ => 'png',
    };
    _resetSubmissionIdentity();
    setState(() {
      _composerAttachments = [
        ..._composerAttachments,
        NewSessionAttachment(
          name:
              'pasted-image-${DateTime.now().millisecondsSinceEpoch}.$extension',
          type: 'image',
          bytes: bytes,
        ),
      ];
      _attachmentError = null;
    });
  }

  Future<void> _insertKeyboardUriContent({
    required String uri,
    required String mimeType,
    required int maxBytes,
  }) async {
    const maxFiles = 10;
    if (_composerAttachments.length >= maxFiles) {
      setState(
        () => _attachmentError = _attachmentLimitErrors(
          skippedTooLarge: 0,
          skippedForLimit: 1,
        ).join(' '),
      );
      return;
    }
    setState(() {
      _readingAttachments = true;
      _attachmentError = null;
    });
    try {
      final result = await ref
          .read(attachmentClipboardProvider)
          .readInsertedContent(
            uri: uri,
            mimeType: mimeType,
            maxBytes: maxBytes,
          );
      if (!mounted) return;
      final errors = _attachmentLimitErrors(
        skippedTooLarge: result.skippedTooLarge,
        skippedForLimit: result.skippedForLimit,
      );
      if (result.attachments.isNotEmpty) {
        _resetSubmissionIdentity();
      }
      setState(() {
        _composerAttachments = [
          ..._composerAttachments,
          ...result.attachments.map(
            (attachment) => NewSessionAttachment(
              name: attachment.name,
              type: attachment.type,
              bytes: attachment.bytes,
            ),
          ),
        ];
        _attachmentError = result.attachments.isEmpty && errors.isEmpty
            ? 'The pasted image could not be read.'
            : errors.isEmpty
            ? null
            : errors.join(' ');
      });
    } catch (_) {
      if (mounted) {
        setState(
          () => _attachmentError = 'The pasted image could not be read.',
        );
      }
    } finally {
      if (mounted) {
        setState(() {
          _readingAttachments = false;
        });
      }
    }
  }

  List<String> _attachmentLimitErrors({
    required int skippedTooLarge,
    required int skippedForLimit,
  }) {
    return [
      if (skippedTooLarge > 0) 'Files must be 25 MB or smaller.',
      if (skippedForLimit > 0)
        'You can attach up to 10 files; '
            '$skippedForLimit '
            '${skippedForLimit == 1 ? 'file was' : 'files were'} not added.',
    ];
  }

  void _resetSubmissionIdentity() {
    ref
        .read(
          sessionComposerControllerProvider(
            FollowupScope(
              workspaceId: workspaceId,
              peonId: peonId,
              sessionId: session?.sessionId ?? _newSessionDraftId,
            ),
          ).notifier,
        )
        .resetSubmissionIdentity();
  }
}

class _AttachmentOption extends StatelessWidget {
  const _AttachmentOption({
    super.key,
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.onTap,
  });

  final IconData icon;
  final String title;
  final String subtitle;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return ListTile(
      onTap: onTap,
      shape: RoundedRectangleBorder(borderRadius: AppMotion.optionShape),
      tileColor: AppColors.iron950,
      leading: Icon(icon, size: 20, color: AppColors.felBright),
      title: Text(
        title,
        style: AppTypography.body(fontWeight: FontWeight.w600),
      ),
      subtitle: Text(
        subtitle,
        style: AppTypography.body(fontSize: 12, color: AppColors.boneFaint),
      ),
      trailing: const Icon(
        LucideIcons.chevronRight,
        size: 16,
        color: AppColors.boneFaint,
      ),
    );
  }
}

bool _isImageName(String name) {
  final lower = name.toLowerCase();
  return const ['.png', '.jpg', '.jpeg', '.gif', '.webp'].any(lower.endsWith);
}

ModelProvider? _modelProviderFor(
  ModelsCatalog? catalog, {
  String? agent,
  String? model,
}) {
  if (catalog == null || catalog.providers.isEmpty) return null;
  for (final provider in catalog.providers) {
    if (provider.agent == agent) return provider;
  }
  if (model != null) {
    for (final provider in catalog.providers) {
      if (provider.models.any(
        (option) => option.id == model || option.alias == model,
      )) {
        return provider;
      }
    }
  }
  for (final provider in catalog.providers) {
    if (provider.agent == catalog.defaultAgent) return provider;
  }
  return catalog.providers.first;
}

String _catalogLabel(
  List<ModelCatalogOption>? options,
  String? value, {
  required String fallback,
}) {
  if (value == null) {
    for (final option in options ?? const <ModelCatalogOption>[]) {
      if (option.isDefault) return option.label;
    }
    return fallback;
  }
  for (final option in options ?? const <ModelCatalogOption>[]) {
    if (option.id == value || option.alias == value) return option.label;
  }
  return value;
}

String? _submissionLabel(SessionComposerState? state, {required bool running}) {
  final followup = state?.followupProgress;
  if (followup != null) {
    return switch (followup.stage) {
      FollowupSubmissionStage.uploading =>
        'Uploading ${followup.current} of ${followup.total}: '
            '${followup.fileName}',
      FollowupSubmissionStage.submitting =>
        running ? 'Adding to queue…' : 'Sending message…',
    };
  }
  final initial = state?.submissionProgress;
  if (initial != null) {
    return switch (initial.stage) {
      NewSessionSubmissionStage.uploading =>
        'Uploading ${initial.current} of ${initial.total}: ${initial.fileName}',
      NewSessionSubmissionStage.starting => 'Starting session…',
    };
  }
  return null;
}

class _TranscriptBody extends StatefulWidget {
  const _TranscriptBody({
    required this.transcript,
    required this.operator,
    required this.viewers,
    required this.bottomPadding,
    required this.showWorking,
    required this.stopping,
    required this.stopError,
    required this.onStop,
    required this.onRefresh,
    required this.onLoadOlder,
    required this.onOpenAttachment,
    required this.onOpenPreview,
  });

  final AsyncValue<TranscriptState> transcript;
  final OperatorIdentity? operator;
  final List<PresenceViewer> viewers;
  final double bottomPadding;
  final bool showWorking;
  final bool stopping;
  final String? stopError;
  final VoidCallback onStop;
  final Future<void> Function() onRefresh;
  final Future<void> Function() onLoadOlder;
  final ValueChanged<TranscriptAttachment> onOpenAttachment;
  final ValueChanged<TranscriptPreviewItem> onOpenPreview;

  @override
  State<_TranscriptBody> createState() => _TranscriptBodyState();
}

class _TranscriptBodyState extends State<_TranscriptBody> {
  static const _bottomThreshold = 24.0;

  final ScrollController _scrollController = ScrollController();

  @override
  void didUpdateWidget(covariant _TranscriptBody oldWidget) {
    super.didUpdateWidget(oldWidget);
    final transcriptChanged =
        oldWidget.transcript.value != widget.transcript.value ||
        oldWidget.showWorking != widget.showWorking;
    if (!transcriptChanged || !_scrollController.hasClients) return;

    final position = _scrollController.position;
    final wasAtBottom =
        position.pixels <= position.minScrollExtent + _bottomThreshold;
    if (!wasAtBottom) return;

    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_scrollController.hasClients) return;
      _scrollController.jumpTo(_scrollController.position.minScrollExtent);
    });
  }

  @override
  void dispose() {
    _scrollController.dispose();
    super.dispose();
  }

  Widget _workingContent(TranscriptEvent? latestEvent) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _TranscriptWorkingIndicator(
          activity: transcriptWorkingActivity(latestEvent),
          stopping: widget.stopping,
          onStop: widget.onStop,
        ),
        if (widget.stopError case final error?)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text(
              '⚠ $error',
              key: const Key('transcript-stop-error'),
              style: AppTypography.mono(fontSize: 10, color: AppColors.ember),
            ),
          ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final state = widget.transcript.value;
    final isLoading =
        widget.transcript.isLoading || (state?.isRefreshing ?? false);

    return Stack(
      fit: StackFit.expand,
      children: [
        widget.transcript.when(
          loading: () => const SizedBox.expand(),
          error: (_, _) => _TranscriptFailure(onRetry: widget.onRefresh),
          data: (state) {
            if (state.events.isEmpty && state.isRefreshing) {
              return const SizedBox.expand();
            }
            if (state.events.isEmpty && !state.isRunning) {
              return _TranscriptEmpty(
                message: state.message,
                onRetry: widget.onRefresh,
              );
            }
            final items = flattenTranscriptEvents(state.events);
            final hasTopControl = state.hasOlder || state.message != null;
            final hasWorking = state.isRunning && widget.showWorking;
            return ListView.builder(
              key: const Key('transcript-list'),
              controller: _scrollController,
              reverse: true,
              padding: EdgeInsets.fromLTRB(16, 16, 12, widget.bottomPadding),
              itemCount:
                  items.length + (hasTopControl ? 1 : 0) + (hasWorking ? 1 : 0),
              itemBuilder: (context, index) {
                if (hasWorking && index == 0) {
                  return Padding(
                    key: ValueKey(
                      'transcript-working-flow-${state.events.lastOrNull?.eventId ?? 'empty'}',
                    ),
                    padding: const EdgeInsets.only(top: 16),
                    child: _workingContent(state.events.lastOrNull),
                  );
                }
                final dataIndex = index - (hasWorking ? 1 : 0);
                if (dataIndex == items.length) {
                  return _TranscriptHistoryControl(
                    state: state,
                    onRetry: widget.onRefresh,
                    onLoadOlder: widget.onLoadOlder,
                  );
                }
                final chronologicalIndex = items.length - 1 - dataIndex;
                final item = items[chronologicalIndex];
                final previous = chronologicalIndex > 0
                    ? items[chronologicalIndex - 1]
                    : null;
                return Padding(
                  key: ValueKey(item.key),
                  padding: EdgeInsets.only(
                    top: transcriptItemGap(previous, item),
                  ),
                  child: TranscriptItemView(
                    item: item,
                    operator: widget.operator,
                    onOpenAttachment: widget.onOpenAttachment,
                    onOpenPreview: widget.onOpenPreview,
                  ),
                );
              },
            );
          },
        ),
        Positioned(
          top: 8,
          left: 16,
          right: 16,
          child: _DelayedTranscriptLoadingPill(isLoading: isLoading),
        ),
        Positioned(
          top: 12,
          right: 14,
          child: PresenceStack(
            key: const Key('session-floating-presence'),
            size: PresenceStackSize.md,
            softShadow: true,
            viewers: [
              for (final viewer in widget.viewers)
                PresencePerson(
                  userId: viewer.userId,
                  displayName: viewer.displayName,
                  avatarUrl: viewer.avatarUrl,
                ),
            ],
          ),
        ),
      ],
    );
  }
}

class _TranscriptWorkingIndicator extends StatefulWidget {
  const _TranscriptWorkingIndicator({
    required this.activity,
    required this.stopping,
    required this.onStop,
  });

  final TranscriptWorkingActivity activity;
  final bool stopping;
  final VoidCallback onStop;

  @override
  State<_TranscriptWorkingIndicator> createState() =>
      _TranscriptWorkingIndicatorState();
}

class _TranscriptWorkingIndicatorState
    extends State<_TranscriptWorkingIndicator>
    with SingleTickerProviderStateMixin {
  late final AnimationController _dots = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1200),
  )..repeat();
  late DateTime _fallbackStartedAt = DateTime.now();
  late Timer _timer;
  DateTime _now = DateTime.now();

  @override
  void initState() {
    super.initState();
    _timer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (!mounted) return;
      setState(() => _now = DateTime.now());
    });
  }

  @override
  void didUpdateWidget(covariant _TranscriptWorkingIndicator oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.activity.startedAt != widget.activity.startedAt ||
        oldWidget.activity.label != widget.activity.label) {
      _fallbackStartedAt = DateTime.now();
      _now = DateTime.now();
    }
  }

  @override
  void dispose() {
    _timer.cancel();
    _dots.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final startedAt = _workingStartedAt(widget.activity.startedAt);
    final duration = _formatWorkingDuration(_now.difference(startedAt));
    return Row(
      key: const Key('transcript-working'),
      children: [
        Flexible(
          child: Semantics(
            label: 'Agent working: ${widget.activity.label}',
            liveRegion: true,
            child: ExcludeSemantics(
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  AnimatedBuilder(
                    animation: _dots,
                    builder: (context, _) {
                      return Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          for (var index = 0; index < 3; index++) ...[
                            if (index > 0) const SizedBox(width: 3),
                            Opacity(
                              opacity:
                                  0.25 +
                                  0.75 *
                                      ((math.sin(
                                                (_dots.value * math.pi * 2) -
                                                    (index * 0.9),
                                              ) +
                                              1) /
                                          2),
                              child: const DecoratedBox(
                                decoration: BoxDecoration(
                                  color: AppColors.felBright,
                                  shape: BoxShape.circle,
                                ),
                                child: SizedBox.square(dimension: 4),
                              ),
                            ),
                          ],
                        ],
                      );
                    },
                  ),
                  const SizedBox(width: 8),
                  Flexible(
                    child: Text(
                      widget.activity.label,
                      key: const Key('transcript-working-label'),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: AppTypography.mono(
                        fontSize: 10,
                        color: AppColors.felBright,
                      ),
                    ),
                  ),
                  const SizedBox(width: 6),
                  Text(
                    '· $duration',
                    key: const Key('transcript-working-duration'),
                    style: AppTypography.mono(
                      fontSize: 10,
                      color: AppColors.boneFaint,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
        const SizedBox(width: 4),
        TextButton.icon(
          key: const Key('transcript-stop'),
          onPressed: widget.stopping ? null : widget.onStop,
          style: TextButton.styleFrom(
            minimumSize: const Size(0, 36),
            padding: const EdgeInsets.symmetric(horizontal: 5),
            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
            foregroundColor: AppColors.ember,
            disabledForegroundColor: AppColors.ember.withValues(alpha: 0.4),
            textStyle: AppTypography.mono(fontSize: 10),
          ),
          icon: const Text('■', style: TextStyle(fontSize: 9, height: 1)),
          label: Text(widget.stopping ? 'Stopping…' : 'Stop'),
        ),
      ],
    );
  }

  DateTime _workingStartedAt(double? raw) {
    if (raw == null || raw <= 0) return _fallbackStartedAt;
    final milliseconds = raw < 100000000000
        ? (raw * 1000).round()
        : raw.round();
    final parsed = DateTime.fromMillisecondsSinceEpoch(milliseconds);
    if (parsed.isAfter(_now)) return _fallbackStartedAt;
    return parsed;
  }
}

String _formatWorkingDuration(Duration elapsed) {
  final totalSeconds = math.max(0, elapsed.inSeconds);
  final seconds = totalSeconds % 60;
  final totalMinutes = totalSeconds ~/ 60;
  if (totalMinutes < 60) {
    return '$totalMinutes:${seconds.toString().padLeft(2, '0')}';
  }
  final hours = totalMinutes ~/ 60;
  final minutes = totalMinutes % 60;
  return '$hours:${minutes.toString().padLeft(2, '0')}:'
      '${seconds.toString().padLeft(2, '0')}';
}

class _DelayedTranscriptLoadingPill extends StatefulWidget {
  const _DelayedTranscriptLoadingPill({required this.isLoading});

  static const delay = Duration(seconds: 2);

  final bool isLoading;

  @override
  State<_DelayedTranscriptLoadingPill> createState() =>
      _DelayedTranscriptLoadingPillState();
}

class _DelayedTranscriptLoadingPillState
    extends State<_DelayedTranscriptLoadingPill> {
  Timer? _showTimer;
  bool _isVisible = false;

  @override
  void initState() {
    super.initState();
    _syncVisibility();
  }

  @override
  void didUpdateWidget(_DelayedTranscriptLoadingPill oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.isLoading != widget.isLoading) {
      _syncVisibility();
    }
  }

  void _syncVisibility() {
    _showTimer?.cancel();
    if (!widget.isLoading) {
      if (_isVisible) {
        setState(() => _isVisible = false);
      }
      return;
    }
    _showTimer = Timer(_DelayedTranscriptLoadingPill.delay, () {
      if (mounted && widget.isLoading) {
        setState(() => _isVisible = true);
      }
    });
  }

  @override
  void dispose() {
    _showTimer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return IgnorePointer(
      child: AnimatedSlide(
        key: const Key('transcript-loading-slide'),
        offset: _isVisible ? Offset.zero : const Offset(0, -1.5),
        duration: _isVisible ? AppMotion.panelClose : AppMotion.base,
        curve: AppMotion.iosQuick,
        child: AnimatedOpacity(
          key: const Key('transcript-loading-opacity'),
          opacity: _isVisible ? 1 : 0,
          duration: const Duration(milliseconds: 300),
          curve: Curves.easeInOutCubic,
          child: Center(
            child: Semantics(
              container: true,
              liveRegion: true,
              label: _isVisible ? 'Loading messages' : null,
              child: ClipRRect(
                borderRadius: BorderRadius.circular(999),
                child: BackdropFilter(
                  filter: ImageFilter.blur(sigmaX: 10, sigmaY: 10),
                  child: DecoratedBox(
                    key: const Key('transcript-loading-pill'),
                    decoration: BoxDecoration(
                      color: AppColors.iron900.withValues(alpha: 0.88),
                      borderRadius: BorderRadius.circular(999),
                      border: Border.all(
                        color: AppColors.bone.withValues(alpha: 0.08),
                      ),
                    ),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 10,
                        vertical: 6,
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          TickerMode(
                            enabled: _isVisible,
                            child: const SizedBox.square(
                              dimension: 12,
                              child: CircularProgressIndicator(
                                strokeWidth: 1.5,
                                color: AppColors.boneDim,
                              ),
                            ),
                          ),
                          const SizedBox(width: 6),
                          Text(
                            'Loading messages…',
                            style: AppTypography.body(
                              fontSize: 11,
                              fontWeight: FontWeight.w500,
                              color: AppColors.boneDim,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _TranscriptHistoryControl extends StatelessWidget {
  const _TranscriptHistoryControl({
    required this.state,
    required this.onRetry,
    required this.onLoadOlder,
  });

  final TranscriptState state;
  final Future<void> Function() onRetry;
  final Future<void> Function() onLoadOlder;

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (state.message case final message?)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Text(
              message,
              key: const Key('transcript-error'),
              textAlign: TextAlign.center,
              style: AppTypography.body(fontSize: 12, color: AppColors.blood),
            ),
          ),
        AppButton(
          key: const Key('transcript-history-action'),
          onPressed: state.hasOlder ? onLoadOlder : onRetry,
          variant: AppButtonVariant.ghost,
          size: AppButtonSize.sm,
          loading: state.isLoadingOlder,
          child: Text(state.hasOlder ? 'Load older events' : 'Retry'),
        ),
      ],
    );
  }
}

class _TranscriptEmpty extends StatelessWidget {
  const _TranscriptEmpty({required this.message, required this.onRetry});

  final String? message;
  final Future<void> Function() onRetry;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              message ?? 'No transcript yet.',
              key: const Key('transcript-empty'),
              textAlign: TextAlign.center,
              style: AppTypography.body(
                fontSize: 14,
                color: message == null ? AppColors.boneDim : AppColors.blood,
              ),
            ),
            if (message != null) ...[
              const SizedBox(height: 12),
              AppButton(
                key: const Key('transcript-retry'),
                onPressed: onRetry,
                variant: AppButtonVariant.secondary,
                size: AppButtonSize.sm,
                child: const Text('Retry'),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _NewSessionBody extends StatelessWidget {
  const _NewSessionBody({
    required this.projects,
    required this.selectedProjectKey,
    required this.onProjectSelected,
    required this.onRetry,
  });

  final AsyncValue<ProjectsState> projects;
  final String? selectedProjectKey;
  final ValueChanged<String> onProjectSelected;
  final Future<void> Function() onRetry;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      key: const Key('new-session-project-selection'),
      builder: (context, constraints) => SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(28, 32, 28, 24),
        child: ConstrainedBox(
          constraints: BoxConstraints(
            minHeight: math.max(0, constraints.maxHeight - 56),
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
                      color: AppColors.boneDim,
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
                    loading: () => const Center(
                      child: SizedBox.square(
                        dimension: 22,
                        child: CircularProgressIndicator(
                          strokeWidth: 1.8,
                          color: AppColors.felBright,
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
      return const Center(
        child: SizedBox.square(
          dimension: 22,
          child: CircularProgressIndicator(
            strokeWidth: 1.8,
            color: AppColors.felBright,
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
            ? AppColors.fel.withValues(alpha: 0.09)
            : AppColors.iron950,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(10),
          side: BorderSide(
            color: selected
                ? AppColors.fel.withValues(alpha: 0.7)
                : AppColors.iron800,
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
                    color: selected ? AppColors.felBright : AppColors.boneFaint,
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
                                ? AppColors.bone
                                : AppColors.boneDim,
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
                              color: AppColors.boneFaint,
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
                      color: selected ? AppColors.forge : Colors.transparent,
                      shape: BoxShape.circle,
                      border: Border.all(
                        color: selected ? AppColors.forge : AppColors.iron700,
                      ),
                    ),
                    alignment: Alignment.center,
                    child: selected
                        ? const Icon(
                            LucideIcons.check,
                            size: 12,
                            color: AppColors.felInk,
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
        color: AppColors.iron950,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: AppColors.iron800),
      ),
      child: Row(
        children: [
          const Icon(LucideIcons.folderX, size: 17, color: AppColors.boneFaint),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              message,
              style: AppTypography.body(fontSize: 12, color: AppColors.boneDim),
            ),
          ),
          TextButton(onPressed: onRetry, child: const Text('Retry')),
        ],
      ),
    );
  }
}

class _TranscriptFailure extends StatelessWidget {
  const _TranscriptFailure({required this.onRetry});

  final Future<void> Function() onRetry;

  @override
  Widget build(BuildContext context) {
    return _TranscriptEmpty(
      message: 'Could not open the transcript cache.',
      onRetry: onRetry,
    );
  }
}

class _SessionHeader extends StatelessWidget {
  const _SessionHeader({
    required this.session,
    required this.details,
    this.isNewSession = false,
  });

  final SessionSummary session;
  final SessionDetails? details;
  final bool isNewSession;

  @override
  Widget build(BuildContext context) {
    final projectKey = session.projectKey?.trim();
    final stats = _statsLabel(details);
    return AppNavigationBar(
      key: const Key('session-navbar'),
      showBackButton: true,
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
                      color: AppColors.forge,
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
                        fontSize: 9,
                        color: AppColors.boneFaint,
                        height: 1.2,
                      ),
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
                  'projectKey': ?session.projectKey,
                  'projectId': ?session.projectId,
                },
              ),
              padding: EdgeInsets.zero,
              constraints: const BoxConstraints.tightFor(width: 36, height: 40),
              style: IconButton.styleFrom(
                minimumSize: const Size(36, 40),
                tapTargetSize: MaterialTapTargetSize.shrinkWrap,
              ),
              icon: const Icon(
                LucideIcons.folderTree,
                size: 18,
                color: AppColors.boneDim,
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
