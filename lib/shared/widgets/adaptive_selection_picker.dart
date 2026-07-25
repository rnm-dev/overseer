import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../design/colors.dart';
import '../design/motion.dart';
import '../design/typography.dart';
import '../layout/responsive_breakpoints.dart';
import 'app_option_bottom_sheet.dart';

typedef AdaptiveSelectionTriggerBuilder =
    Widget Function(
      BuildContext context,
      String selectedLabel,
      bool expanded,
      VoidCallback onTap,
    );

@immutable
class SelectionOption<T extends Object> {
  const SelectionOption({required this.value, required this.label});

  final T value;
  final String label;
}

class AdaptiveSelectionPicker<T extends Object> extends StatefulWidget {
  const AdaptiveSelectionPicker({
    super.key,
    required this.title,
    required this.value,
    required this.options,
    required this.onSelected,
    this.triggerBuilder,
  });

  final String title;
  final T value;
  final List<SelectionOption<T>> options;
  final ValueChanged<T> onSelected;
  final AdaptiveSelectionTriggerBuilder? triggerBuilder;

  @override
  State<AdaptiveSelectionPicker<T>> createState() =>
      _AdaptiveSelectionPickerState<T>();
}

class _AdaptiveSelectionPickerState<T extends Object>
    extends State<AdaptiveSelectionPicker<T>> {
  final MenuController _menuController = MenuController();
  bool _compactPickerOpen = false;

  SelectionOption<T> get _selected {
    return widget.options.firstWhere(
      (option) => option.value == widget.value,
      orElse: () => widget.options.first,
    );
  }

  Future<void> _showCompactPicker() async {
    if (_compactPickerOpen) return;
    setState(() => _compactPickerOpen = true);
    final selected = await showAppOptionBottomSheet<T>(
      context: context,
      builder: (context) => _SelectionBottomSheet<T>(
        title: widget.title,
        value: widget.value,
        options: widget.options,
      ),
    );
    if (!mounted) return;
    setState(() => _compactPickerOpen = false);
    if (selected != null) widget.onSelected(selected);
  }

  @override
  Widget build(BuildContext context) {
    final compact =
        ResponsiveBreakpoints.sizeFor(MediaQuery.sizeOf(context).width) ==
        ResponsiveLayoutSize.compact;

    if (compact) {
      if (widget.triggerBuilder case final triggerBuilder?) {
        return triggerBuilder(
          context,
          _selected.label,
          _compactPickerOpen,
          _showCompactPicker,
        );
      }
      return _PickerTrigger(
        label: _selected.label,
        expanded: _compactPickerOpen,
        onTap: _showCompactPicker,
      );
    }

    return MenuAnchor(
      controller: _menuController,
      alignmentOffset: const Offset(-136, 8),
      style: MenuStyle(
        backgroundColor: const WidgetStatePropertyAll(AppColors.iron900),
        surfaceTintColor: const WidgetStatePropertyAll(Colors.transparent),
        elevation: const WidgetStatePropertyAll(16),
        shadowColor: WidgetStatePropertyAll(
          AppColors.voidColor.withValues(alpha: 0.62),
        ),
        padding: const WidgetStatePropertyAll(EdgeInsets.all(8)),
        shape: const WidgetStatePropertyAll(
          RoundedRectangleBorder(
            side: BorderSide(color: AppColors.iron700),
            borderRadius: BorderRadius.all(Radius.circular(14)),
          ),
        ),
      ),
      menuChildren: [
        for (final option in widget.options)
          MenuItemButton(
            onPressed: () => widget.onSelected(option.value),
            style: ButtonStyle(
              minimumSize: const WidgetStatePropertyAll(Size(220, 48)),
              padding: const WidgetStatePropertyAll(
                EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              ),
              foregroundColor: const WidgetStatePropertyAll(AppColors.bone),
              overlayColor: WidgetStatePropertyAll(
                AppColors.fel.withValues(alpha: 0.12),
              ),
              shape: const WidgetStatePropertyAll(
                RoundedRectangleBorder(
                  borderRadius: BorderRadius.all(Radius.circular(10)),
                ),
              ),
            ),
            child: _OptionContent(
              label: option.label,
              selected: option.value == widget.value,
            ),
          ),
      ],
      builder: (context, controller, _) {
        void toggleMenu() {
          if (controller.isOpen) {
            controller.close();
          } else {
            controller.open();
          }
          setState(() {});
        }

        if (widget.triggerBuilder case final triggerBuilder?) {
          return triggerBuilder(
            context,
            _selected.label,
            controller.isOpen,
            toggleMenu,
          );
        }
        return _PickerTrigger(
          label: _selected.label,
          expanded: controller.isOpen,
          onTap: toggleMenu,
        );
      },
    );
  }
}

class _PickerTrigger extends StatelessWidget {
  const _PickerTrigger({
    required this.label,
    required this.expanded,
    required this.onTap,
  });

  final String label;
  final bool expanded;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      expanded: expanded,
      label: label,
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: onTap,
          borderRadius: const BorderRadius.all(Radius.circular(10)),
          overlayColor: WidgetStatePropertyAll(
            AppColors.fel.withValues(alpha: 0.1),
          ),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 10),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                AnimatedSwitcher(
                  duration: AppMotion.fast,
                  switchInCurve: AppMotion.softSettle,
                  switchOutCurve: Curves.easeIn,
                  child: Text(
                    label,
                    key: ValueKey(label),
                    style: AppTypography.controlValue(),
                  ),
                ),
                const SizedBox(width: 4),
                AnimatedRotation(
                  turns: expanded ? 0.5 : 0,
                  duration: AppMotion.base,
                  curve: AppMotion.iosQuick,
                  child: const Icon(
                    LucideIcons.chevronDown,
                    size: 18,
                    color: AppColors.boneDim,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _SelectionBottomSheet<T extends Object> extends StatefulWidget {
  const _SelectionBottomSheet({
    required this.title,
    required this.value,
    required this.options,
  });

  final String title;
  final T value;
  final List<SelectionOption<T>> options;

  @override
  State<_SelectionBottomSheet<T>> createState() =>
      _SelectionBottomSheetState<T>();
}

class _SelectionBottomSheetState<T extends Object>
    extends State<_SelectionBottomSheet<T>>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;
  bool _motionInitialized = false;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: AppMotion.panelOpen,
    );
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_motionInitialized) return;
    _motionInitialized = true;
    if (MediaQuery.disableAnimationsOf(context)) {
      _controller.value = 1;
    } else {
      _controller.forward();
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AppOptionBottomSheet(
      title: widget.title,
      handleKey: const Key('selection-sheet-handle'),
      children: [
        for (var index = 0; index < widget.options.length; index++)
          _AnimatedOption(
            animation: CurvedAnimation(
              parent: _controller,
              curve: Interval(
                math.min(index * 0.07, 0.28),
                1,
                curve: AppMotion.softSettle,
              ),
            ),
            option: widget.options[index],
            selected: widget.options[index].value == widget.value,
          ),
      ],
    );
  }
}

class _AnimatedOption<T extends Object> extends StatelessWidget {
  const _AnimatedOption({
    required this.animation,
    required this.option,
    required this.selected,
  });

  final Animation<double> animation;
  final SelectionOption<T> option;
  final bool selected;

  @override
  Widget build(BuildContext context) {
    return FadeTransition(
      opacity: animation,
      child: SlideTransition(
        position: Tween<Offset>(
          begin: const Offset(0, 0.16),
          end: Offset.zero,
        ).animate(animation),
        child: AppOptionSheetTile(
          key: Key('selection-option-${option.label}'),
          selected: selected,
          onTap: () => Navigator.of(context).pop(option.value),
          child: _OptionContent(label: option.label, selected: selected),
        ),
      ),
    );
  }
}

class _OptionContent extends StatelessWidget {
  const _OptionContent({required this.label, required this.selected});

  final String label;
  final bool selected;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        Expanded(
          child: Text(
            label,
            style: AppTypography.optionLabel(selected: selected),
          ),
        ),
        AnimatedScale(
          scale: selected ? 1 : 0,
          duration: AppMotion.fast,
          curve: AppMotion.softSettle,
          child: const Icon(
            LucideIcons.check,
            size: 20,
            color: AppColors.felBright,
          ),
        ),
      ],
    );
  }
}
