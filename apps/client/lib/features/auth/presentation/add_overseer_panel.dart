import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:overseer_mobile/core/config/overseer_connection_store.dart';
import 'package:overseer_mobile/features/auth/domain/auth_models.dart';
import 'package:overseer_mobile/shared/design/colors.dart';
import 'package:overseer_mobile/shared/widgets/app_bottom_sheet.dart';
import 'package:overseer_mobile/shared/widgets/app_button.dart';
import 'package:overseer_mobile/shared/widgets/app_text_field.dart';

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
        _errorText = 'Enter a valid http:// or https:// URL.';
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
        _errorText = 'This Overseer connection is already saved.';
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
        _errorText = 'The Overseer URL could not be opened. Please try again.';
        _submitting = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
      child: AppBottomSheet(
        title: 'Add Overseer',
        handleKey: const Key('add-overseer-panel-handle'),
        children: [
          AppTextField(
            key: const Key('overseer-url-field'),
            controller: _controller,
            label: 'Overseer URL',
            hint: 'https://overseer.example',
            helperText: 'This address is saved after you successfully sign in.',
            errorText: _errorText,
            prefix: const Icon(
              LucideIcons.globe,
              size: 18,
              color: AppColors.boneDim,
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
            child: Text(_submitting ? 'Checking sign-in…' : 'Continue'),
          ),
        ],
      ),
    );
  }
}
