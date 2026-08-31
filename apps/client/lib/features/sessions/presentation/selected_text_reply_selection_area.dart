import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show SelectedContent;

import '../domain/session_models.dart';

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
