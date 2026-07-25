import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:overseer_mobile/core/config/overseer_connection_store.dart';
import 'package:overseer_mobile/shared/design/colors.dart';
import 'package:overseer_mobile/shared/design/spacing.dart';
import 'package:overseer_mobile/shared/design/typography.dart';
import 'package:overseer_mobile/shared/widgets/app_button.dart';
import 'package:overseer_mobile/shared/widgets/app_text_field.dart';
import 'package:overseer_mobile/shared/widgets/overseer_logo.dart';

class ServerSetupPage extends StatefulWidget {
  const ServerSetupPage({
    super.key,
    required this.onContinue,
    this.onBack,
    this.initialUrl = '',
    this.logo = const OverseerLogo(),
  });

  final String initialUrl;
  final Future<void> Function(Uri serverUrl) onContinue;
  final VoidCallback? onBack;
  final Widget logo;

  @override
  State<ServerSetupPage> createState() => _ServerSetupPageState();
}

class _ServerSetupPageState extends State<ServerSetupPage> {
  static const String _heroAssetPath = 'assets/images/sign-in-hero.png';

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
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _errorText = 'The Overseer URL could not be saved. Please try again.';
        _submitting = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Stack(
        fit: StackFit.expand,
        children: <Widget>[
          const Image(
            key: Key('server-setup-hero'),
            image: AssetImage(_heroAssetPath),
            fit: BoxFit.cover,
            filterQuality: FilterQuality.high,
            excludeFromSemantics: true,
          ),
          const DecoratedBox(
            decoration: BoxDecoration(
              gradient: LinearGradient(
                begin: Alignment.topCenter,
                end: Alignment.bottomCenter,
                colors: <Color>[
                  Color(0x1A060806),
                  Color(0x40060806),
                  AppColors.voidColor,
                ],
                stops: <double>[0, 0.48, 1],
              ),
            ),
          ),
          SafeArea(
            child: Padding(
              padding: context.appSpacing.screenInsets(top: 20, bottom: 20),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: <Widget>[
                  Stack(
                    alignment: Alignment.center,
                    children: <Widget>[
                      Center(child: widget.logo),
                      if (widget.onBack != null)
                        Align(
                          alignment: Alignment.topLeft,
                          child: IconButton(
                            key: const Key('server-setup-back'),
                            tooltip: 'Back to connections',
                            onPressed: widget.onBack,
                            icon: const Icon(
                              LucideIcons.arrowLeft,
                              color: AppColors.bone,
                            ),
                          ),
                        ),
                    ],
                  ),
                  const Spacer(),
                  Text(
                    'Add Overseer',
                    textAlign: TextAlign.center,
                    style: AppTypography.display(
                      fontSize: 22,
                      fontWeight: FontWeight.w700,
                      color: AppColors.bone,
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    'Enter the address of your Overseer server.',
                    textAlign: TextAlign.center,
                    style: AppTypography.body(
                      fontSize: 14,
                      color: AppColors.boneDim,
                    ),
                  ),
                  const SizedBox(height: 20),
                  AppTextField(
                    key: const Key('overseer-url-field'),
                    controller: _controller,
                    label: 'OVERSEER URL',
                    hint: 'https://overseer.example',
                    helperText:
                        'This address will be remembered on this device.',
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
                    child: Text(_submitting ? 'Saving…' : 'Add Overseer'),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
