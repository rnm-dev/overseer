import 'session_models.dart';

enum SessionContinuationFailure { forkTimeout, missingHistory }

SessionContinuationFailure? sessionContinuationFailure(TranscriptEvent? event) {
  if (event?.type != 'result' || event!.payload['is_error'] != true) {
    return null;
  }
  final errors = event.payload['errors'];
  final details = errors is List ? errors.whereType<String>().join('\n') : '';
  if (RegExp(
    r'thread/fork timed out after \d+ms',
    caseSensitive: false,
  ).hasMatch(details)) {
    return SessionContinuationFailure.forkTimeout;
  }
  if (RegExp(
    r'invalid paginated history lineage[\s\S]*missing source rollout',
    caseSensitive: false,
  ).hasMatch(details)) {
    return SessionContinuationFailure.missingHistory;
  }
  return null;
}

String? lastUnexecutedUserPrompt(List<TranscriptEvent> events) {
  for (final event in events.reversed) {
    final text = event.type == 'user_message'
        ? event.payload['text'] as String?
        : null;
    if (text?.trim().isNotEmpty == true) return text!.trim();
  }
  return null;
}

String continuationRecoveryPrompt({
  required String sourceSessionId,
  required String sourceUrl,
  required String? prompt,
}) => <String>[
  'Continue the work from a Peon session that could not be resumed.',
  'Source Peon session: $sourceSessionId',
  'Source URL: $sourceUrl',
  'Use the project documentation and current workspace state as the durable context. '
      'Do not attempt to fork or resume the source provider thread.',
  if (prompt?.trim().isNotEmpty == true)
    'The request that was not executed:\n\n${prompt!.trim()}'
  else
    'Ask the operator what should be continued if the durable project context is insufficient.',
].join('\n\n');
