import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:overseer_mobile/shared/widgets/adaptive_dialog.dart';
import 'package:overseer_mobile/shared/widgets/presence_stack.dart';
import 'package:overseer_mobile/shared/widgets/user_avatar.dart';

void main() {
  Widget host(Widget child) {
    return MaterialApp(
      home: Scaffold(body: Center(child: child)),
    );
  }

  testWidgets('UserAvatar renders initial fallback for missing source', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      host(const UserAvatar(label: 'Alice', size: UserAvatarSize.md)),
    );

    expect(find.text('A'), findsOneWidget);
    expect(find.byType(Text), findsOneWidget);
    expect(find.text('B'), findsNothing);
  });

  testWidgets('UserAvatar covers its bounds when rendering an image', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      host(
        const UserAvatar(
          label: 'Alice',
          src: 'https://example.com/avatar.png',
          size: UserAvatarSize.md,
        ),
      ),
    );

    final image = tester.widget<Image>(find.byType(Image));
    expect(image.fit, BoxFit.cover);
    expect(image.width, 28);
    expect(image.height, 28);
  });

  testWidgets('PresenceStack shows up to three avatars and overflow chip', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      host(
        PresenceStack(
          size: PresenceStackSize.sm,
          viewers: const [
            PresencePerson(userId: '1', displayName: 'Alice'),
            PresencePerson(userId: '2', displayName: 'Bob'),
            PresencePerson(userId: '3', displayName: 'Chad'),
            PresencePerson(userId: '4', displayName: 'Dana'),
          ],
        ),
      ),
    );

    expect(find.byType(UserAvatar), findsNWidgets(3));
    expect(find.text('+1'), findsOneWidget);
    expect(tester.getSize(find.byType(PresenceStack)), const Size(62, 20));
    expect(
      tester.getTopLeft(find.byType(UserAvatar).at(1)).dx -
          tester.getTopLeft(find.byType(UserAvatar).at(0)).dx,
      14,
    );
    expect(
      tester.getTopLeft(find.byType(UserAvatar).at(2)).dx -
          tester.getTopLeft(find.byType(UserAvatar).at(1)).dx,
      14,
    );
  });

  testWidgets('PresenceStack animates viewers in and out', (tester) async {
    const stackKey = Key('animated-presence');

    await tester.pumpWidget(
      host(
        const PresenceStack(
          key: stackKey,
          size: PresenceStackSize.md,
          viewers: [],
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.pumpWidget(
      host(
        const PresenceStack(
          key: stackKey,
          size: PresenceStackSize.md,
          viewers: [PresencePerson(userId: '1', displayName: 'Alice')],
        ),
      ),
    );
    await tester.pump();

    expect(find.byType(UserAvatar), findsOneWidget);
    final enteringFade = tester.widget<FadeTransition>(
      find
          .ancestor(
            of: find.byType(UserAvatar),
            matching: find.byType(FadeTransition),
          )
          .first,
    );
    expect(enteringFade.opacity.value, 0);

    await tester.pump(const Duration(milliseconds: 80));
    expect(enteringFade.opacity.value, greaterThan(0));
    expect(enteringFade.opacity.value, lessThan(1));
    await tester.pumpAndSettle();
    expect(tester.getSize(find.byKey(stackKey)), const Size(28, 28));

    await tester.pumpWidget(
      host(
        const PresenceStack(
          key: stackKey,
          size: PresenceStackSize.md,
          viewers: [],
        ),
      ),
    );
    await tester.pump();
    expect(find.byType(UserAvatar), findsOneWidget);
    await tester.pumpAndSettle();
    expect(find.byType(UserAvatar), findsNothing);
    expect(tester.getSize(find.byKey(stackKey)), Size.zero);
  });

  testWidgets('PresenceStack can add a soft floating shadow', (tester) async {
    await tester.pumpWidget(
      host(
        const PresenceStack(
          softShadow: true,
          viewers: [PresencePerson(userId: 'viewer-1', displayName: 'Viewer')],
        ),
      ),
    );

    final decoration = tester
        .widgetList<DecoratedBox>(
          find.descendant(
            of: find.byKey(const ValueKey('presence-viewer-1')),
            matching: find.byType(DecoratedBox),
          ),
        )
        .map((box) => box.decoration)
        .whereType<BoxDecoration>()
        .firstWhere((decoration) => decoration.boxShadow?.length == 2);

    expect(decoration.boxShadow!.first.blurRadius, 18);
    expect(decoration.boxShadow!.first.spreadRadius, 5);
    expect(decoration.boxShadow!.first.offset, const Offset(0, 3));
  });

  Future<void> openDialog(
    WidgetTester tester,
    double width,
    double height,
  ) async {
    tester.view.physicalSize = Size(width, height);
    tester.view.devicePixelRatio = 1.0;

    await tester.pumpWidget(
      host(
        Builder(
          builder: (context) => ElevatedButton(
            onPressed: () => showAdaptiveAppDialog<void>(
              context: context,
              title: 'Session',
              content: const Text('Dialog content'),
            ),
            child: const Text('open'),
          ),
        ),
      ),
    );

    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
  }

  testWidgets('showAdaptiveAppDialog opens bottom sheet on narrow layout', (
    WidgetTester tester,
  ) async {
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });

    await openDialog(tester, 360, 800);

    expect(find.byType(BottomSheet), findsOneWidget);
    expect(find.byType(Dialog), findsNothing);
  });

  testWidgets('showAdaptiveAppDialog opens centered Dialog on wide layout', (
    WidgetTester tester,
  ) async {
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });

    await openDialog(tester, 1024, 1200);

    expect(find.byType(Dialog), findsOneWidget);
    expect(find.byType(BottomSheet), findsNothing);
  });
}
