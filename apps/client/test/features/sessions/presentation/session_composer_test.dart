import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:overseer_mobile/features/sessions/domain/followup_repository.dart';
import 'package:overseer_mobile/features/sessions/domain/new_session_repository.dart';
import 'package:overseer_mobile/features/sessions/application/voice_dictation_controller.dart';
import 'package:overseer_mobile/features/sessions/presentation/session_composer.dart';
import 'package:overseer_mobile/features/themes/app_theme_package.dart';
import 'package:overseer_mobile/shared/design/spacing.dart';
import 'package:overseer_mobile/shared/design/theme.dart';
import 'package:overseer_mobile/shared/design/typography.dart';
import 'package:overseer_mobile/shared/models/ai_capabilities.dart';
import 'package:overseer_mobile/shared/widgets/app_button.dart';
import 'package:overseer_mobile/shared/widgets/app_markdown.dart';

void main() {
  test('inserts dictation at the selection without clobbering the draft', () {
    final result = insertVoiceTranscript(
      const TextEditingValue(
        text: 'hello world',
        selection: TextSelection(baseOffset: 6, extentOffset: 11),
      ),
      'привет',
    );

    expect(result.text, 'hello привет');
    expect(result.selection, const TextSelection.collapsed(offset: 12));
  });

  testWidgets('shows live dictation without disabling the draft', (
    tester,
  ) async {
    final controller = TextEditingController(text: 'half typed');
    addTearDown(controller.dispose);

    final package = AppThemePackages.resolve('org.overseer.parchment');
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.fromPackage(package),
        home: Scaffold(
          body: SessionComposer(
            controller: controller,
            dictation: const VoiceDictationState(
              phase: VoiceDictationPhase.recording,
              enabled: true,
              duration: Duration(seconds: 108),
              amplitude: 0.8,
            ),
          ),
        ),
      ),
    );

    expect(find.byKey(const Key('session-composer-voice')), findsOneWidget);
    expect(find.byKey(const Key('session-composer-recording')), findsOneWidget);
    expect(
      tester
          .getSize(find.byKey(const Key('session-composer-recording')))
          .height,
      24,
    );
    expect(
      find.byKey(const Key('session-composer-recording-countdown')),
      findsOneWidget,
    );
    final dot = find.byKey(const Key('session-composer-recording-dot'));
    final shellTopLeft = tester.getTopLeft(
      find.byKey(const Key('session-composer-shell')),
    );
    final dotTopLeft = tester.getTopLeft(dot);
    expect(
      dotTopLeft.dx,
      tester.getTopLeft(find.byKey(const Key('session-composer-input'))).dx + 4,
    );
    expect(dotTopLeft.dx - shellTopLeft.dx, 12);
    expect(dotTopLeft.dy - shellTopLeft.dy, 12);
    expect(
      tester.widget<Text>(find.text('REC')).style?.fontFamily,
      AppTypography.fontFamily,
    );
    final initialOpacity = tester.widget<FadeTransition>(dot).opacity.value;
    await tester.pump(const Duration(milliseconds: 425));
    expect(
      tester.widget<FadeTransition>(dot).opacity.value,
      isNot(initialOpacity),
    );
    expect(
      tester
          .widget<TextField>(find.byKey(const Key('session-composer-input')))
          .enabled,
      isTrue,
    );
    expect(
      find.descendant(
        of: find.byKey(const Key('session-composer-recording')),
        matching: find.byType(IconButton),
      ),
      findsNothing,
    );
  });

  testWidgets('hides disabled voice and keeps composer usable in flight', (
    tester,
  ) async {
    final controller = TextEditingController();
    addTearDown(controller.dispose);
    var canceled = false;
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: SessionComposer(
            controller: controller,
            dictation: const VoiceDictationState(
              phase: VoiceDictationPhase.transcribing,
              enabled: true,
            ),
            onVoiceCancel: () => canceled = true,
          ),
        ),
      ),
    );
    expect(
      find.byKey(const Key('session-composer-transcribing')),
      findsOneWidget,
    );
    expect(
      tester
          .getSize(find.byKey(const Key('session-composer-transcribing')))
          .height,
      24,
    );
    expect(
      tester
          .widget<TextField>(find.byKey(const Key('session-composer-input')))
          .enabled,
      isTrue,
    );
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    expect(
      tester.widget<Text>(find.text('TRANSCRIBING')).style?.fontFamily,
      AppTypography.fontFamily,
    );
    final voiceButton = tester.widget<IconButton>(
      find.byKey(const Key('session-composer-voice')),
    );
    expect(voiceButton.tooltip, 'Cancel transcription');
    expect(voiceButton.onPressed, isNotNull);
    await tester.tap(find.byKey(const Key('session-composer-voice')));
    expect(canceled, isTrue);

    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: SessionComposer(
            controller: controller,
            dictation: const VoiceDictationState(
              phase: VoiceDictationPhase.unavailable,
            ),
          ),
        ),
      ),
    );
    expect(find.byKey(const Key('session-composer-voice')), findsNothing);
  });

  testWidgets('voice errors do not change composer geometry', (tester) async {
    final controller = TextEditingController();
    addTearDown(controller.dispose);

    Future<void> pumpWithError(String? error) {
      return tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.dark,
          home: Scaffold(
            body: Align(
              alignment: Alignment.bottomCenter,
              child: SessionComposer(
                controller: controller,
                dictation: VoiceDictationState(
                  phase: VoiceDictationPhase.idle,
                  enabled: true,
                  error: error,
                  canOpenSettings: error != null,
                ),
              ),
            ),
          ),
        ),
      );
    }

    await pumpWithError(null);
    final height = tester
        .getSize(find.byKey(const Key('session-composer-shell')))
        .height;
    await pumpWithError('Microphone access is blocked.');

    expect(
      tester.getSize(find.byKey(const Key('session-composer-shell'))).height,
      height,
    );
    expect(find.text('Microphone access is blocked.'), findsNothing);
  });

  testWidgets('matches the compact web composer hierarchy', (tester) async {
    final controller = TextEditingController();
    addTearDown(controller.dispose);

    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: Align(
            alignment: Alignment.bottomCenter,
            child: SessionComposer(controller: controller),
          ),
        ),
      ),
    );

    expect(find.byKey(const Key('session-composer-gradient')), findsOneWidget);
    expect(find.byKey(const Key('session-composer-shell')), findsOneWidget);
    expect(find.byKey(const Key('session-composer-input')), findsOneWidget);
    expect(find.bySemanticsLabel('Message'), findsOneWidget);
    expect(find.byKey(const Key('session-composer-attach')), findsOneWidget);
    expect(find.byKey(const Key('session-composer-submit')), findsOneWidget);
    expect(
      find.byKey(const Key('session-composer-stop-and-run')),
      findsNothing,
    );
    expect(
      tester.getSize(find.byKey(const Key('session-composer-attach'))),
      const Size(38, 44),
    );
    expect(
      tester.getSize(find.byKey(const Key('session-composer-submit'))),
      const Size(38, 44),
    );
    expect(
      tester.getSize(find.byKey(const Key('session-composer-attach-visual'))),
      const Size(32, 32),
    );
    final shellRect = tester.getRect(
      find.byKey(const Key('session-composer-shell')),
    );
    final attachRect = tester.getRect(
      find.byKey(const Key('session-composer-attach-visual')),
    );
    final submitRect = tester.getRect(
      find.byKey(const Key('session-composer-submit-visual')),
    );
    final inputRect = tester.getRect(
      find.byKey(const Key('session-composer-input')),
    );
    final leftInset = attachRect.left - shellRect.left;
    final rightInset = shellRect.right - submitRect.right;
    final bottomInset = shellRect.bottom - submitRect.bottom;
    expect(attachRect.top - inputRect.bottom, 6);
    expect(leftInset, 8);
    expect(rightInset, leftInset);
    expect(bottomInset, 10);
    expect(
      tester.getSize(find.byKey(const Key('session-composer-submit-visual'))),
      const Size(32, 32),
    );
    expect(
      tester.getSize(find.byKey(const Key('session-composer-input'))).height,
      32,
    );

    final submit = tester.widget<IconButton>(
      find.byKey(const Key('session-composer-submit')),
    );
    expect(submit.onPressed, isNull);

    await tester.tap(find.byKey(const Key('session-composer-input')));
    await tester.enterText(
      find.byKey(const Key('session-composer-input')),
      'Follow up',
    );
    await tester.pump();

    final shell = tester.widget<AnimatedContainer>(
      find.byKey(const Key('session-composer-shell')),
    );
    final decoration = shell.foregroundDecoration! as BoxDecoration;
    expect(
      decoration.border,
      Border.all(
        color: Theme.of(
          tester.element(find.byKey(const Key('session-composer-shell'))),
        ).colorScheme.primary,
      ),
    );
  });

  testWidgets('keeps equal gaps between adjacent composer controls', (
    tester,
  ) async {
    final controller = TextEditingController(text: 'Follow up');
    addTearDown(controller.dispose);

    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: Align(
            alignment: Alignment.bottomCenter,
            child: SessionComposer(
              controller: controller,
              running: true,
              dictation: const VoiceDictationState(
                phase: VoiceDictationPhase.idle,
                enabled: true,
              ),
              providers: const [
                ModelProvider(
                  agent: 'codex',
                  label: 'Codex',
                  models: [],
                  reasoningEfforts: [],
                ),
              ],
              onSubmit: () {},
            ),
          ),
        ),
      ),
    );

    final attach = tester.getRect(
      find.byKey(const Key('session-composer-attach-visual')),
    );
    final voice = tester.getRect(
      find.byKey(const Key('session-composer-voice-visual')),
    );
    final capability = tester.getRect(
      find.byKey(const Key('session-composer-capabilities-visual')),
    );
    final queue = tester.getRect(
      find.byKey(const Key('session-composer-submit-visual')),
    );

    expect(voice.left - attach.right, AppSpacing.xxs + 2);
    expect(capability.left - voice.right, AppSpacing.xxs + 2);
    expect(
      find.byKey(const Key('session-composer-stop-and-run')),
      findsNothing,
    );
    expect(queue.right, lessThanOrEqualTo(tester.view.physicalSize.width));
  });

  testWidgets('combines agent, model, and effort in one radio sheet', (
    tester,
  ) async {
    final controller = TextEditingController();
    addTearDown(controller.dispose);
    String? selectedAgent;
    String? selectedModel;
    String? selectedEffort;
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: SessionComposer(
            controller: controller,
            providers: const [
              ModelProvider(
                agent: 'codex',
                label: 'Codex',
                models: [ModelCatalogOption(id: 'gpt-5', label: 'GPT-5')],
                reasoningEfforts: [
                  ModelCatalogOption(id: 'high', label: 'High'),
                ],
              ),
              ModelProvider(
                agent: 'claude',
                label: 'Claude',
                models: [ModelCatalogOption(id: 'opus', label: 'Opus')],
                reasoningEfforts: [],
              ),
            ],
            defaultAgent: 'codex',
            onAgentChanged: (value) => selectedAgent = value,
            onModelChanged: (value) => selectedModel = value,
            onReasoningEffortChanged: (value) => selectedEffort = value,
          ),
        ),
      ),
    );

    expect(
      find.byKey(const Key('session-composer-capabilities')),
      findsOneWidget,
    );
    expect(find.text('Codex · Default · Default'), findsOneWidget);

    await tester.tap(find.byKey(const Key('session-composer-capabilities')));
    await tester.pumpAndSettle();
    expect(find.text('Agent, model & effort'), findsOneWidget);
    expect(find.byType(RadioListTile<String>), findsNWidgets(6));

    await tester.tap(find.text('Claude').last);
    await tester.pump();
    expect(selectedAgent, 'claude');

    await tester.tap(find.text('Codex').last);
    await tester.pump();
    await tester.tap(find.text('GPT-5').last);
    await tester.pump();
    expect(selectedModel, 'gpt-5');

    await tester.tap(find.text('High').last);
    await tester.pump();
    expect(selectedEffort, 'high');
  });

  testWidgets('keeps the agent fixed for an existing session', (tester) async {
    final controller = TextEditingController();
    addTearDown(controller.dispose);

    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: SessionComposer(
            controller: controller,
            allowAgentSelection: false,
            providers: const [
              ModelProvider(
                agent: 'codex',
                label: 'Codex',
                models: [ModelCatalogOption(id: 'gpt-5', label: 'GPT-5')],
                reasoningEfforts: [],
              ),
              ModelProvider(
                agent: 'claude',
                label: 'Claude',
                models: [ModelCatalogOption(id: 'opus', label: 'Opus')],
                reasoningEfforts: [],
              ),
            ],
            defaultAgent: 'codex',
          ),
        ),
      ),
    );

    expect(
      find.bySemanticsLabel(RegExp(r'^Model and effort:')),
      findsOneWidget,
    );
    await tester.tap(find.byKey(const Key('session-composer-capabilities')));
    await tester.pumpAndSettle();

    expect(find.text('Model & effort'), findsOneWidget);
    expect(find.text('Agent'), findsNothing);
    expect(find.text('Claude'), findsNothing);
    expect(find.text('GPT-5'), findsOneWidget);
  });

  testWidgets(
    'hides provider-wide efforts for a model with an empty scoped list',
    (tester) async {
      final controller = TextEditingController();
      addTearDown(controller.dispose);
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.dark,
          home: Scaffold(
            body: SessionComposer(
              controller: controller,
              providers: const [
                ModelProvider(
                  agent: 'claude',
                  label: 'Claude',
                  models: [
                    ModelCatalogOption(
                      id: 'haiku',
                      label: 'Haiku',
                      isDefault: true,
                      reasoningEfforts: [],
                    ),
                    ModelCatalogOption(
                      id: 'opus',
                      label: 'Opus',
                      reasoningEfforts: [
                        ModelCatalogOption(id: 'high', label: 'High'),
                      ],
                    ),
                  ],
                  reasoningEfforts: [
                    ModelCatalogOption(id: 'high', label: 'High'),
                  ],
                ),
              ],
              defaultAgent: 'claude',
            ),
          ),
        ),
      );

      await tester.tap(find.byKey(const Key('session-composer-capabilities')));
      await tester.pumpAndSettle();
      expect(find.text('Effort'), findsNothing);
      expect(find.text('High'), findsNothing);
    },
  );

  testWidgets('enables send for non-empty input and submits once', (
    tester,
  ) async {
    final controller = TextEditingController();
    addTearDown(controller.dispose);
    var submissions = 0;
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: SessionComposer(
            controller: controller,
            onSubmit: () => submissions++,
          ),
        ),
      ),
    );

    await tester.enterText(
      find.byKey(const Key('session-composer-input')),
      'Ship it',
    );
    await tester.pump();
    await tester.tap(find.byKey(const Key('session-composer-submit')));
    await tester.pump();

    expect(submissions, 1);
  });

  testWidgets('uses Enter as a line break without submitting', (tester) async {
    final controller = TextEditingController(text: 'First line');
    addTearDown(controller.dispose);
    var submissions = 0;

    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: SessionComposer(
            controller: controller,
            onSubmit: () => submissions++,
          ),
        ),
      ),
    );

    await tester.tap(find.byKey(const Key('session-composer-input')));
    controller.selection = TextSelection.collapsed(
      offset: controller.text.length,
    );
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();

    expect(controller.text, 'First line\n');
    expect(submissions, 0);
    expect(
      tester
          .widget<TextField>(find.byKey(const Key('session-composer-input')))
          .textInputAction,
      TextInputAction.newline,
    );
  });

  testWidgets(
    'keeps pending state inside the submit button when attachments are shown',
    (tester) async {
      final controller = TextEditingController(text: 'Next task');
      addTearDown(controller.dispose);

      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.dark,
          home: Scaffold(
            body: Align(
              alignment: Alignment.bottomCenter,
              child: SessionComposer(
                controller: controller,
                running: true,
                pending: true,
                error: 'Could not send',
                attachments: [
                  NewSessionAttachment(
                    name: 'plan.md',
                    type: 'file',
                    bytes: Uint8List.fromList([1, 2, 3]),
                  ),
                ],
                onSubmit: () {},
              ),
            ),
          ),
        ),
      );

      expect(
        find.byKey(const Key('session-composer-stop-and-run')),
        findsNothing,
      );
      expect(find.byKey(const Key('session-composer-error')), findsOneWidget);
      expect(find.text('⚠ Could not send'), findsOneWidget);
      expect(
        find.byKey(const Key('session-composer-attachments')),
        findsOneWidget,
      );
      expect(find.text('plan.md'), findsOneWidget);
      expect(
        find.byKey(const Key('session-composer-pending-label')),
        findsNothing,
      );
      expect(find.byIcon(LucideIcons.hourglass), findsNothing);
      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      expect(
        tester
            .widget<IconButton>(
              find.byKey(const Key('session-composer-submit')),
            )
            .onPressed,
        isNull,
      );
    },
  );

  testWidgets(
    'offers queue without a composer-level send-now action while running',
    (tester) async {
      final controller = TextEditingController();
      addTearDown(controller.dispose);
      var queued = 0;

      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.dark,
          home: Scaffold(
            body: Align(
              alignment: Alignment.bottomCenter,
              child: SessionComposer(
                controller: controller,
                running: true,
                onSubmit: () => queued++,
              ),
            ),
          ),
        ),
      );

      final queueFinder = find.byKey(const Key('session-composer-submit'));
      expect(tester.widget<IconButton>(queueFinder).onPressed, isNull);
      expect(
        find.byKey(const Key('session-composer-stop-and-run')),
        findsNothing,
      );

      await tester.enterText(
        find.byKey(const Key('session-composer-input')),
        'Next task',
      );
      await tester.pump();

      expect(tester.widget<IconButton>(queueFinder).onPressed, isNotNull);
      expect(find.byTooltip('Queue'), findsOneWidget);
      expect(find.byTooltip('Send now'), findsNothing);
      expect(
        find.descendant(
          of: queueFinder,
          matching: find.byIcon(LucideIcons.listPlus),
        ),
        findsOneWidget,
      );

      await tester.tap(queueFinder);
      await tester.pump();
      expect(queued, 1);
    },
  );

  testWidgets('accepts rich image content inserted by the keyboard', (
    tester,
  ) async {
    final controller = TextEditingController();
    addTearDown(controller.dispose);
    KeyboardInsertedContent? inserted;
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: SessionComposer(
            controller: controller,
            onContentInserted: (content) => inserted = content,
          ),
        ),
      ),
    );

    final field = tester.widget<TextField>(
      find.byKey(const Key('session-composer-input')),
    );
    expect(field.contentInsertionConfiguration, isNotNull);
    expect(
      field.contentInsertionConfiguration!.allowedMimeTypes,
      contains('image/png'),
    );
    field.contentInsertionConfiguration!.onContentInserted(
      KeyboardInsertedContent(
        mimeType: 'image/png',
        uri: 'content://clipboard/image',
        data: Uint8List.fromList([1, 2, 3]),
      ),
    );

    expect(inserted?.mimeType, 'image/png');
    expect(inserted?.data, [1, 2, 3]);
  });

  testWidgets('renders authoritative queued follow-ups with item actions', (
    tester,
  ) async {
    final controller = TextEditingController();
    addTearDown(controller.dispose);
    final package = AppThemePackages.resolve('org.overseer.parchment');
    String? sent;
    String? removed;
    String? edited;

    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.fromPackage(package),
        home: Scaffold(
          body: Align(
            alignment: Alignment.bottomCenter,
            child: SessionComposer(
              controller: controller,
              queuedItems: const [
                QueuedFollowup(
                  id: 'queue-1',
                  sessionId: 'session',
                  prompt:
                      '**Review** the `deployment` before release. '
                      'Confirm the migration, inspect the logs, and verify the '
                      'mobile smoke test before sending the final update.',
                  attachments: [
                    QueuedFollowupAttachment(
                      type: 'file',
                      path: 'uploads/session/plan.md',
                    ),
                  ],
                  model: 'gpt-5',
                  reasoningEffort: 'high',
                  queuedAt: 1,
                ),
              ],
              onSteerQueued: (id) async => sent = id,
              onRemoveQueued: (id) async => removed = id,
              onEditQueued: (id, prompt) async => edited = '$id:$prompt',
            ),
          ),
        ),
      ),
    );

    expect(find.byKey(const Key('session-queue-list')), findsOneWidget);
    final markdown = tester.widget<AppMarkdownPreview>(
      find.byKey(const Key('session-queue-markdown-queue-1')),
    );
    expect(markdown.maxLines, 3);
    expect(markdown.overflow, TextOverflow.ellipsis);
    expect(find.text('📎 plan.md'), findsOneWidget);
    expect(find.text('gpt-5'), findsNothing);
    expect(find.text('high'), findsNothing);
    expect(
      tester.getSize(find.byKey(const Key('session-queue-item-queue-1'))).width,
      tester.getSize(find.byKey(const Key('session-composer-shell'))).width,
    );

    await tester.tap(find.byKey(const Key('session-queue-open-queue-1')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('session-queue-dialog')), findsOneWidget);
    final dialog = tester.widget<ConstrainedBox>(
      find.byKey(const Key('session-queue-dialog')),
    );
    final surface = dialog.child! as DecoratedBox;
    final decoration = surface.decoration as BoxDecoration;
    expect(decoration.color, package.surfaceRaised);
    expect(decoration.border, Border.all(color: package.edge));
    expect(
      tester.getSize(find.byKey(const Key('session-queue-dialog'))).height,
      lessThanOrEqualTo(
        tester.view.physicalSize.height / tester.view.devicePixelRatio * 0.8,
      ),
    );
    expect(find.byKey(const Key('session-queue-dialog-steer')), findsOneWidget);
    expect(find.text('Steer'), findsOneWidget);
    expect(
      find.byKey(const Key('session-queue-dialog-delete')),
      findsOneWidget,
    );
    expect(
      tester
          .widget<AppButton>(
            find.byKey(const Key('session-queue-dialog-delete')),
          )
          .variant,
      AppButtonVariant.dangerGhost,
    );
    expect(find.byKey(const Key('session-queue-dialog-edit')), findsOneWidget);

    await tester.tap(find.byKey(const Key('session-queue-dialog-edit')));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.descendant(
        of: find.byKey(const Key('session-queue-edit-field')),
        matching: find.byType(TextField),
      ),
      'Edited queued message',
    );
    await tester.tap(find.byKey(const Key('session-queue-edit-save')));
    await tester.pumpAndSettle();
    expect(edited, 'queue-1:Edited queued message');
    expect(find.byKey(const Key('session-queue-dialog')), findsNothing);

    await tester.tap(find.byKey(const Key('session-queue-open-queue-1')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('session-queue-dialog-steer')));
    await tester.pumpAndSettle();
    expect(sent, 'queue-1');

    await tester.tap(find.byKey(const Key('session-queue-open-queue-1')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('session-queue-dialog-delete')));
    await tester.pumpAndSettle();
    expect(removed, 'queue-1');
  });

  testWidgets('shows attachments and allows an attachment-only session', (
    tester,
  ) async {
    final controller = TextEditingController();
    addTearDown(controller.dispose);
    var submitted = false;
    var removed = -1;
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: SessionComposer(
            controller: controller,
            attachments: [
              NewSessionAttachment(
                name: 'plan.md',
                type: 'file',
                bytes: Uint8List.fromList([1, 2, 3]),
              ),
            ],
            onRemoveAttachment: (index) => removed = index,
            onSubmit: () => submitted = true,
          ),
        ),
      ),
    );

    expect(
      find.byKey(const Key('session-composer-attachments')),
      findsOneWidget,
    );
    expect(find.text('plan.md'), findsOneWidget);
    await tester.tap(find.byKey(const Key('session-composer-submit')));
    expect(submitted, isTrue);
    await tester.tap(find.byTooltip('Remove plan.md'));
    expect(removed, 0);
  });

  testWidgets('a huge paste is offered as an attachment, not as body text', (
    tester,
  ) async {
    final controller = TextEditingController();
    addTearDown(controller.dispose);
    final messenger = tester.binding.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'Clipboard.getData') {
        return <String, dynamic>{'text': 'x' * 5000};
      }
      return null;
    });
    addTearDown(
      () => messenger.setMockMethodCallHandler(SystemChannels.platform, null),
    );
    String? pasted;

    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: SessionComposer(
            controller: controller,
            onLongTextPasted: (text) {
              pasted = text;
              return true;
            },
          ),
        ),
      ),
    );

    await tester.tap(find.byKey(const Key('session-composer-input')));
    await tester.pump();
    await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.keyV);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
    await tester.pumpAndSettle();

    expect(pasted?.length, 5000);
    expect(controller.text, isEmpty);
  });

  testWidgets('a paste the host cannot take still lands in the field', (
    tester,
  ) async {
    final controller = TextEditingController();
    addTearDown(controller.dispose);
    final messenger = tester.binding.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'Clipboard.getData') {
        return <String, dynamic>{'text': 'y' * 5000};
      }
      return null;
    });
    addTearDown(
      () => messenger.setMockMethodCallHandler(SystemChannels.platform, null),
    );

    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: SessionComposer(
            controller: controller,
            onLongTextPasted: (text) => false,
          ),
        ),
      ),
    );

    await tester.tap(find.byKey(const Key('session-composer-input')));
    await tester.pump();
    await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.keyV);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
    await tester.pumpAndSettle();

    expect(controller.text.length, 5000);
  });

  test('a plain paste replaces the selection at the caret', () {
    final result = insertPastedText(
      const TextEditingValue(
        text: 'hello world',
        selection: TextSelection(baseOffset: 6, extentOffset: 11),
      ),
      'there',
    );

    expect(result.text, 'hello there');
    expect(result.selection, const TextSelection.collapsed(offset: 11));
  });
}
