import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../features/auth/application/auth_controller.dart';
import '../features/auth/application/auth_state.dart';
import '../features/auth/presentation/sign_in_page.dart';
import '../features/sessions/application/sessions_controller.dart';
import '../features/sessions/domain/session_models.dart';
import '../features/sessions/sessions.dart';
import '../features/shell/shell.dart';

class SessionDeepLinkPage extends ConsumerWidget {
  const SessionDeepLinkPage({
    super.key,
    required this.workspaceId,
    required this.peonId,
    required this.sessionId,
  });

  final String workspaceId;
  final String peonId;
  final String sessionId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final auth = ref.watch(authControllerProvider);
    return switch (auth.phase) {
      AuthPhase.restoring => const ShellPage.loading(),
      AuthPhase.unauthenticated => SignInPage(
        onSignIn: ref.read(authControllerProvider.notifier).signIn,
        errorMessage: auth.errorMessage,
      ),
      AuthPhase.signingIn => SignInPage(
        onSignIn: ref.read(authControllerProvider.notifier).signIn,
        isSigningIn: true,
      ),
      AuthPhase.authenticated => _ResolvedSessionPage(
        workspaceId: workspaceId,
        peonId: peonId,
        sessionId: sessionId,
      ),
    };
  }
}

class _ResolvedSessionPage extends ConsumerStatefulWidget {
  const _ResolvedSessionPage({
    required this.workspaceId,
    required this.peonId,
    required this.sessionId,
  });

  final String workspaceId;
  final String peonId;
  final String sessionId;

  @override
  ConsumerState<_ResolvedSessionPage> createState() =>
      _ResolvedSessionPageState();
}

class _ResolvedSessionPageState extends ConsumerState<_ResolvedSessionPage> {
  late final Future<SessionSummary> _session = _resolve();

  Future<SessionSummary> _resolve() async {
    final cached = await ref
        .read(sessionRepositoryProvider)
        .loadCachedSessions(
          workspaceId: widget.workspaceId,
          peonId: widget.peonId,
        );
    return cached
            .where((session) => session.sessionId == widget.sessionId)
            .firstOrNull ??
        SessionSummary(
          workspaceId: widget.workspaceId,
          peonId: widget.peonId,
          sessionId: widget.sessionId,
          status: 'running',
          title: 'Session',
          syncedAt: DateTime.now().millisecondsSinceEpoch.toDouble(),
        );
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<SessionSummary>(
      future: _session,
      builder: (context, snapshot) {
        if (!snapshot.hasData) {
          return const Scaffold(
            body: Center(child: CircularProgressIndicator()),
          );
        }
        return SessionDetailPage(session: snapshot.requireData);
      },
    );
  }
}
