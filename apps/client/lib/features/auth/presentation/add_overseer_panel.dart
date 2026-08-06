import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:overseer_mobile/core/config/overseer_connection_store.dart';
import 'package:overseer_mobile/features/auth/domain/auth_models.dart';
import 'package:overseer_mobile/shared/design/colors.dart';
import 'package:overseer_mobile/shared/widgets/app_bottom_sheet.dart';
import 'package:overseer_mobile/shared/widgets/app_button.dart';
import 'package:overseer_mobile/shared/widgets/app_text_field.dart';
import 'package:overseer_mobile/l10n/l10n.dart';

class AddOverseerPanel extends StatefulWidget {
  const AddOverseerPanel({
    super.key,
    required this.onContinue,
    this.initialUrl = '',
  });

  final String initialUrl;
  final Future<void> Function(Uri serverUrl) onContinue;

  @override
  State<AddOverseerPanel> createState() => _AddOverseerPanelState();
}

class _AddOverseerPanelState extends State<AddOverseerPanel> {
  late final TextEditingController _controller;
  String? _errorText;
  bool _submitting = false;

  @override
  void initState() {
    super.initState();
    _controller = TextEditingController(text: widget.initialUrl);
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_submitting) return;

    final serverUrl = parseOverseerServerUrl(_controller.text);
    if (serverUrl == null) {
      setState(() {
        _errorText = context.l10n.invalidOverseerUrl;
      });
      return;
    }

    setState(() {
      _errorText = null;
      _submitting = true;
    });
    try {
      await widget.onContinue(serverUrl);
    } on DuplicateOverseerConnectionException {
      if (!mounted) return;
      setState(() {
        _errorText = context.l10n.duplicateOverseerConnection;
        _submitting = false;
      });
    } on AuthException catch (error) {
      if (!mounted) return;
      setState(() {
        _errorText = error.message;
        _submitting = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _errorText = context.l10n.overseerUrlOpenFailed;
        _submitting = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final l10n = context.l10n;
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: AppBottomSheet(
        title: l10n.addOverseerTitle,
        handleKey: const Key('add-overseer-panel-handle'),
        children: [
          AppTextField(
            key: const Key('overseer-url-field'),
            controller: _controller,
            label: l10n.overseerUrl,
            hint: l10n.overseerUrlHint,
            helperText: l10n.overseerUrlHelper,
            errorText: _errorText,
            prefix: Icon(
              LucideIcons.globe,
              size: 18,
              color: AppThemePalette.of(context).inkMuted,
            ),
            enabled: !_submitting,
            keyboardType: TextInputType.url,
            textInputAction: TextInputAction.done,
            autocorrect: false,
            smartDashesType: SmartDashesType.disabled,
            smartQuotesType: SmartQuotesType.disabled,
            onSubmitted: (_) => _submit(),
          ),
          const SizedBox(height: 16),
          AppButton(
            key: const Key('server-setup-continue'),
            onPressed: _submit,
            loading: _submitting,
            disabled: _submitting,
            fullWidth: true,
            size: AppButtonSize.lg,
            child: Text(_submitting ? l10n.checkingSignIn : l10n.continueLabel),
          ),
        ],
      ),
    );
  }
}
