import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show SelectedContent;

import '../../../shared/design/typography.dart';
import '../domain/session_models.dart';

/// Preview of a selected-text reply, shown in the composer (clearable) and on
/// the sent user bubble. Tapping it opens the source when [onOpenSource] is set.
class SelectedTextReplyCard extends StatelessWidget {
  const SelectedTextReplyCard({
    super.key,
    required this.replyTo,
    this.onClear,
    this.onOpenSource,
  });

  final SelectedTextReply replyTo;
  final VoidCallback? onClear;
  final VoidCallback? onOpenSource;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final preview = replyTo.selectedText.length > 240
        ? '${replyTo.selectedText.substring(0, 240)}…'
        : replyTo.selectedText;
    final card = Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
      decoration: BoxDecoration(
        color: colors.primary.withValues(alpha: 0.06),
        border: Border.all(color: colors.primary.withValues(alpha: 0.25)),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(Icons.subdirectory_arrow_left, size: 14, color: colors.primary),
          const SizedBox(width: 6),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Selected text',
                  style: AppTypography.mono(
                    fontSize: 9,
                    color: colors.onSurfaceVariant,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  preview,
                  maxLines: 3,
                  overflow: TextOverflow.ellipsis,
                  style: AppTypography.body(
                    fontSize: 11,
                    color: colors.onSurfaceVariant,
                  ),
                ),
              ],
            ),
          ),
          if (onClear != null)
            IconButton(
              key: const Key('session-composer-clear-reply-to'),
              onPressed: onClear,
              tooltip: 'Clear selected-text reply',
              icon: const Icon(Icons.close, size: 15),
              visualDensity: VisualDensity.compact,
            ),
        ],
      ),
    );
    if (onOpenSource == null) return card;
    return InkWell(
      onTap: onOpenSource,
      borderRadius: BorderRadius.circular(8),
      child: card,
    );
  }
}

/// Selection remains a presentation-only state. Reply metadata is created
/// only by an explicit action in the platform selection toolbar.
class SelectedTextReplySelectionArea extends StatefulWidget {
  const SelectedTextReplySelectionArea({
    super.key,
    required this.eventId,
    required this.onReply,
    required this.child,
  });

  final String? eventId;
  final ValueChanged<SelectedTextReply>? onReply;
  final Widget child;

  @override
  State<SelectedTextReplySelectionArea> createState() =>
      _SelectedTextReplySelectionAreaState();
}

class _SelectedTextReplySelectionAreaState
    extends State<SelectedTextReplySelectionArea> {
  String? _selectedText;

  void _rememberSelection(SelectedContent? content) {
    // Do not call widget.onReply here. Selection changes are deliberately
    // neutral; this cache is consumed only when the toolbar is opened.
    _selectedText = content?.plainText;
  }

  Widget _contextMenuBuilder(
    BuildContext context,
    SelectableRegionState selectableRegionState,
  ) {
    final reply = SelectedTextReply.fromSelection(
      eventId: widget.eventId,
      selectedText: _selectedText,
    );
    final buttonItems = selectedTextReplyContextMenuItems(
      standardItems: selectableRegionState.contextMenuButtonItems,
      reply: reply,
      onReply: reply == null || widget.onReply == null
          ? null
          : () {
              selectableRegionState.hideToolbar();
              widget.onReply!(reply);
            },
    );
    return AdaptiveTextSelectionToolbar.buttonItems(
      anchors: selectableRegionState.contextMenuAnchors,
      buttonItems: buttonItems,
    );
  }

  @override
  void didUpdateWidget(covariant SelectedTextReplySelectionArea oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.eventId != widget.eventId) _selectedText = null;
  }

  @override
  Widget build(BuildContext context) {
    return SelectionArea(
      contextMenuBuilder: _contextMenuBuilder,
      onSelectionChanged: _rememberSelection,
      child: widget.child,
    );
  }
}

/// Keeps Flutter's platform-provided selection actions and adds Reply only
/// when the selection has already passed the selected-text contract checks.
List<ContextMenuButtonItem> selectedTextReplyContextMenuItems({
  required List<ContextMenuButtonItem> standardItems,
  required SelectedTextReply? reply,
  required VoidCallback? onReply,
}) {
  if (reply == null || onReply == null) return [...standardItems];
  return [
    ContextMenuButtonItem(
      type: ContextMenuButtonType.custom,
      label: 'Reply',
      onPressed: onReply,
    ),
    ...standardItems,
  ];
}
