import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../shared/design/colors.dart';
import '../../../shared/design/typography.dart';
import '../../../shared/widgets/app_button.dart';
import '../../../shared/widgets/app_navigation_bar.dart';
import '../../../shared/widgets/app_text_field.dart';
import '../application/projects_controller.dart';
import '../domain/project_models.dart';

class NewProjectPage extends ConsumerStatefulWidget {
  const NewProjectPage({super.key, required this.scope});

  final ProjectsScope scope;

  @override
  ConsumerState<NewProjectPage> createState() => _NewProjectPageState();
}

class _NewProjectPageState extends ConsumerState<NewProjectPage> {
  final _labelController = TextEditingController();
  final _dirController = TextEditingController();
  final _metadataController = TextEditingController();
  Timer? _suggestionTimer;
  var _dirTouched = false;
  var _suggestionEpoch = 0;
  String? _suggestedKey;
  String? _error;
  var _submitting = false;

  @override
  void dispose() {
    _suggestionTimer?.cancel();
    _labelController.dispose();
    _dirController.dispose();
    _metadataController.dispose();
    super.dispose();
  }

  void _labelChanged(String value) {
    setState(() {
      _error = null;
      if (value.trim().isEmpty) _suggestedKey = null;
    });
    _suggestionTimer?.cancel();
    final label = value.trim();
    if (label.isEmpty) return;
    final epoch = ++_suggestionEpoch;
    _suggestionTimer = Timer(const Duration(milliseconds: 350), () async {
      try {
        final suggestion = await ref
            .read(projectsControllerProvider(widget.scope).notifier)
            .suggestProject(label);
        if (!mounted || epoch != _suggestionEpoch) return;
        setState(() {
          _suggestedKey = suggestion.key;
          if (!_dirTouched) {
            _dirController.text = suggestion.dir ?? '';
          }
        });
      } on ProjectsException {
        // Suggestions are helpful but optional, matching the web behavior.
      }
    });
  }

  Future<void> _submit() async {
    final label = _labelController.text.trim();
    if (_submitting || label.isEmpty) return;
    setState(() {
      _submitting = true;
      _error = null;
    });
    final dir = _dirController.text.trim();
    final metadata = _metadataController.text;
    try {
      await ref
          .read(projectsControllerProvider(widget.scope).notifier)
          .createProject(
            label: label,
            dir: dir.isEmpty ? null : dir,
            metadata: metadata.isEmpty ? null : metadata,
          );
      if (mounted) Navigator.of(context).pop();
    } on ProjectsException catch (error) {
      if (!mounted) return;
      setState(() {
        _submitting = false;
        _error = error.code == 'PROJECT_EXISTS'
            ? 'A project with that key already exists.'
            : error.message;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _submitting = false;
        _error = 'Could not create the project.';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: !_submitting,
      child: Scaffold(
        key: const Key('new-project-page'),
        body: SafeArea(
          top: false,
          child: Column(
            children: [
              AppNavigationBar(
                showBackButton: true,
                backButtonKey: const Key('new-project-back'),
                onBack: _submitting
                    ? null
                    : () => Navigator.of(context).maybePop(),
                contentHeight: 56,
                contentPadding: const EdgeInsets.fromLTRB(8, 8, 12, 4),
                left: Text('New project', style: AppTypography.sectionTitle()),
              ),
              Expanded(
                child: SingleChildScrollView(
                  padding: const EdgeInsets.fromLTRB(16, 22, 16, 24),
                  child: Align(
                    alignment: Alignment.topCenter,
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 640),
                      child: _buildForm(),
                    ),
                  ),
                ),
              ),
              DecoratedBox(
                decoration: const BoxDecoration(
                  color: AppColors.iron950,
                  border: Border(
                    top: BorderSide(color: AppColors.iron800, width: 0.5),
                  ),
                ),
                child: SafeArea(
                  top: false,
                  minimum: const EdgeInsets.fromLTRB(16, 10, 16, 12),
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.end,
                    children: [
                      AppButton(
                        key: const Key('cancel-new-project'),
                        variant: AppButtonVariant.secondary,
                        disabled: _submitting,
                        onPressed: () => Navigator.of(context).pop(),
                        child: const Text('Cancel'),
                      ),
                      const SizedBox(width: 8),
                      ListenableBuilder(
                        listenable: _labelController,
                        builder: (_, _) => AppButton(
                          key: const Key('create-new-project'),
                          loading: _submitting,
                          disabled: _labelController.text.trim().isEmpty,
                          onPressed: _submit,
                          child: Text(_submitting ? 'Creating…' : 'Create'),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildForm() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        AppTextField(
          key: const Key('new-project-label'),
          controller: _labelController,
          label: 'LABEL',
          hint: 'My Project',
          autofocus: true,
          enabled: !_submitting,
          textCapitalization: TextCapitalization.words,
          textInputAction: TextInputAction.next,
          onChanged: _labelChanged,
        ),
        if (_suggestedKey case final key? when key.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: Text(
              'key: $key',
              key: const Key('new-project-suggested-key'),
              style: AppTypography.mono(
                fontSize: 11,
                color: AppColors.boneFaint,
              ),
            ),
          ),
        const SizedBox(height: 18),
        AppTextField(
          key: const Key('new-project-dir'),
          controller: _dirController,
          label: 'DIRECTORY',
          hint: '/home/peon/Projects/…',
          mono: true,
          enabled: !_submitting,
          textInputAction: TextInputAction.next,
          autocorrect: false,
          onChanged: (_) {
            _dirTouched = true;
            if (_error != null) setState(() => _error = null);
          },
        ),
        const SizedBox(height: 18),
        AppTextField(
          key: const Key('new-project-metadata'),
          controller: _metadataController,
          label: 'METADATA',
          enabled: !_submitting,
          minLines: 7,
          maxLines: 12,
          keyboardType: TextInputType.multiline,
          textInputAction: TextInputAction.newline,
          textCapitalization: TextCapitalization.sentences,
          onChanged: (_) {
            if (_error != null) setState(() => _error = null);
          },
        ),
        if (_error case final error?)
          Padding(
            padding: const EdgeInsets.only(top: 14),
            child: Text(
              '⚠ $error',
              key: const Key('new-project-error'),
              style: AppTypography.mono(fontSize: 12, color: AppColors.blood),
            ),
          ),
      ],
    );
  }
}
