import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../domain/followup_repository.dart';

final sessionQueueChangeProvider = NotifierProvider.autoDispose
    .family<SessionQueueChangeNotifier, SessionQueueSignal, FollowupScope>(
      SessionQueueChangeNotifier.new,
    );

class SessionQueueSignal {
  const SessionQueueSignal({this.revision = 0, this.hasPending = false});

  final int revision;
  final bool hasPending;
}

class SessionQueueChangeNotifier extends Notifier<SessionQueueSignal> {
  SessionQueueChangeNotifier(this.scope);

  final FollowupScope scope;

  @override
  SessionQueueSignal build() => const SessionQueueSignal();

  void notifyChanged() {
    state = SessionQueueSignal(
      revision: state.revision + 1,
      hasPending: state.hasPending,
    );
  }

  void replacePending(bool hasPending) {
    if (state.hasPending == hasPending) return;
    state = SessionQueueSignal(
      revision: state.revision,
      hasPending: hasPending,
    );
  }
}
