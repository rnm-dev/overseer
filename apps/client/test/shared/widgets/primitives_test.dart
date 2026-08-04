import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:overseer_mobile/shared/design/colors.dart';
import 'package:overseer_mobile/shared/design/theme.dart';
import 'package:overseer_mobile/shared/widgets/app_button.dart';
import 'package:overseer_mobile/shared/widgets/app_card.dart';
import 'package:overseer_mobile/shared/widgets/app_list_tile.dart';
import 'package:overseer_mobile/shared/widgets/app_page_header.dart';
import 'package:overseer_mobile/shared/widgets/app_section_header.dart';
import 'package:overseer_mobile/shared/widgets/app_text_field.dart';
import 'package:overseer_mobile/shared/widgets/status_badge.dart';
import 'package:overseer_mobile/shared/widgets/status_dot.dart';
import 'package:overseer_mobile/shared/widgets/surface.dart';

void main() {
  testWidgets('shared headers keep page and section hierarchy distinct', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: Column(
            children: [
              AppPageHeader(
                title: 'Overseer connections',
                subtitle: 'Choose an Overseer to continue.',
              ),
              AppSectionHeader(
                title: 'Settings',
                subtitle: 'Device preferences',
              ),
            ],
          ),
        ),
      ),
    );

    final pageTitle = tester.widget<Text>(find.text('Overseer connections'));
    final sectionTitle = tester.widget<Text>(find.text('Settings'));
    expect(
      pageTitle.style?.fontSize,
      greaterThan(sectionTitle.style!.fontSize!),
    );
    expect(sectionTitle.style?.color, AppColors.bone);
  });

  testWidgets('AppCard composes the shared surface contract', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: AppCard(key: ValueKey('card'), child: Text('Grouped content')),
        ),
      ),
    );

    final card = tester.widget<AppCard>(find.byKey(const ValueKey('card')));
    final surface = tester.widget<Surface>(
      find.descendant(
        of: find.byKey(const ValueKey('card')),
        matching: find.byType(Surface),
      ),
    );
    expect(surface.padding, card.padding);
    expect(surface.borderRadius, card.borderRadius);
  });

  testWidgets(
    'AppListTile owns shared list visuals and interaction semantics',
    (WidgetTester tester) async {
      var taps = 0;
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.dark,
          home: Scaffold(
            body: AppListTile(
              key: const ValueKey('list-tile'),
              title: 'Notifications',
              leading: const Icon(Icons.notifications),
              trailing: const Text('On'),
              onTap: () => taps += 1,
              semanticsHint: 'Manage notification preferences',
            ),
          ),
        ),
      );

      expect(
        tester.getSize(find.byKey(const ValueKey('list-tile'))).height,
        greaterThanOrEqualTo(56),
      );
      final decoration =
          tester
                  .widget<AnimatedContainer>(
                    find.descendant(
                      of: find.byKey(const ValueKey('list-tile')),
                      matching: find.byType(AnimatedContainer),
                    ),
                  )
                  .decoration
              as BoxDecoration;
      expect(decoration.border!.top.color, AppColors.iron800);

      final semantics = tester.getSemantics(
        find.byKey(const ValueKey('list-tile')),
      );
      expect(semantics.label, contains('Notifications'));
      expect(semantics.hint, contains('Manage notification preferences'));

      await tester.tap(find.byKey(const ValueKey('list-tile')));
      expect(taps, 1);
    },
  );

  testWidgets("Surface uses variants and calls onTap when interactive", (
    WidgetTester tester,
  ) async {
    var clicked = false;
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: Surface(
            key: const ValueKey("surface"),
            variant: SurfaceVariant.lit,
            onTap: () => clicked = true,
            child: const Text("panel"),
          ),
        ),
      ),
    );

    final surface = tester.widget<AnimatedContainer>(
      find.byType(AnimatedContainer),
    );
    final decoration = surface.decoration as BoxDecoration;
    expect(decoration.color, AppColors.iron900);
    expect(decoration.border!.top.color, AppColors.felDeep);

    await tester.tap(find.text("panel"));
    expect(clicked, isTrue);
  });

  testWidgets("AppButton reflects loading state and blocks callback", (
    WidgetTester tester,
  ) async {
    var pressed = 0;
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: AppButton(
            key: const ValueKey("loading-button"),
            onPressed: () => pressed += 1,
            loading: true,
            variant: AppButtonVariant.primary,
            child: const Text("Save"),
          ),
        ),
      ),
    );

    expect(find.byType(CircularProgressIndicator), findsOneWidget);

    await tester.tap(find.byType(TextButton));
    expect(pressed, 0);
  });

  testWidgets("AppButton variant and disabled states follow expected palette", (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: AppButton(
            key: const ValueKey("button"),
            onPressed: null,
            disabled: true,
            variant: AppButtonVariant.danger,
            child: const Text("Delete"),
          ),
        ),
      ),
    );

    final button = tester.widget<TextButton>(find.byType(TextButton));
    final style = button.style;
    final background = style?.backgroundColor?.resolve({WidgetState.disabled});
    expect(background, isNotNull);
    expect(background?.a, lessThan(1));
    expect(style?.textStyle?.resolve({})?.letterSpacing, isNull);
  });

  testWidgets(
    "AppTextField exposes label, helper, error and prefix/suffix nodes",
    (WidgetTester tester) async {
      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.dark,
          home: Scaffold(
            body: AppTextField(
              key: const ValueKey("field"),
              label: "Path",
              hint: "enter path",
              helperText: "Path helper",
              errorText: "Path invalid",
              mono: true,
              prefix: const Icon(Icons.folder),
              suffix: const Icon(Icons.close),
            ),
          ),
        ),
      );

      expect(find.text("Path"), findsOneWidget);
      expect(find.text("Path helper"), findsNothing);
      expect(find.text("Path invalid"), findsOneWidget);
      expect(find.byIcon(Icons.folder), findsOneWidget);
      expect(find.byIcon(Icons.close), findsOneWidget);

      final textField = tester.widget<TextField>(find.byType(TextField));
      expect(textField.style?.fontFamily, "monospace");
    },
  );

  testWidgets("StatusBadge maps tones to distinct palette colors", (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: Column(
            children: [
              const StatusBadge(
                key: Key("badge-success"),
                tone: StatusBadgeTone.success,
                label: "Success",
              ),
              const StatusBadge(
                key: Key("badge-error"),
                tone: StatusBadgeTone.danger,
                label: "Error",
              ),
            ],
          ),
        ),
      ),
    );

    final successBadge = tester.widget<Container>(
      find.descendant(
        of: find.byKey(const Key("badge-success")),
        matching: find.byType(Container),
      ),
    );
    final errorBadge = tester.widget<Container>(
      find.descendant(
        of: find.byKey(const Key("badge-error")),
        matching: find.byType(Container),
      ),
    );
    final successFill = (successBadge.decoration as BoxDecoration).color!;
    final errorFill = (errorBadge.decoration as BoxDecoration).color!;
    expect(successFill != errorFill, true);
    expect(successFill.toARGB32(), equals(const Color(0x2086AB63).toARGB32()));
    expect(errorFill.toARGB32(), equals(const Color(0x1AD95F48).toARGB32()));
  });

  testWidgets("StatusDot provides semantic label and state color", (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: AppTheme.dark,
        home: Scaffold(
          body: StatusDot(
            key: const ValueKey("status-dot"),
            state: StatusDotState.busy,
            semanticLabel: "Worker is busy",
          ),
        ),
      ),
    );

    final semantics = tester.widget<Semantics>(
      find.descendant(
        of: find.byKey(const ValueKey("status-dot")),
        matching: find.byType(Semantics),
      ),
    );
    expect(semantics.properties.label, "Worker is busy");

    final dot = tester.widget<Container>(
      find
          .descendant(
            of: find.byKey(const ValueKey("status-dot")),
            matching: find.byType(Container),
          )
          .first,
    );
    final decoration = dot.decoration as BoxDecoration;
    expect(decoration.color, AppColors.forge);
  });
}
