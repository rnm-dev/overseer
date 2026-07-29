import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:overseer_mobile/shared/widgets/overseer_logo.dart';

void main() {
  testWidgets('default logo exactly matches the native splash canvas', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      const MaterialApp(home: Center(child: OverseerLogo())),
    );

    expect(
      tester.getSize(find.byType(Image)),
      const Size.square(OverseerLogo.splashExtent),
    );
    final image = tester.widget<Image>(find.byType(Image));
    expect(image.image, const AssetImage(OverseerLogo.assetPath));
  });

  testWidgets('OverseerLogo exposes the product name to assistive technology', (
    WidgetTester tester,
  ) async {
    final SemanticsHandle semantics = tester.ensureSemantics();

    await tester.pumpWidget(
      MaterialApp(
        home: Center(
          child: OverseerLogo(
            size: 96,
            imageProvider: MemoryImage(_transparentPixel),
          ),
        ),
      ),
    );

    expect(find.bySemanticsLabel('Overseer'), findsOneWidget);
    expect(tester.getSize(find.byType(Image)), const Size(96, 96));
    semantics.dispose();
  });
}

final Uint8List _transparentPixel = Uint8List.fromList(<int>[
  137,
  80,
  78,
  71,
  13,
  10,
  26,
  10,
  0,
  0,
  0,
  13,
  73,
  72,
  68,
  82,
  0,
  0,
  0,
  1,
  0,
  0,
  0,
  1,
  8,
  6,
  0,
  0,
  0,
  31,
  21,
  196,
  137,
  0,
  0,
  0,
  13,
  73,
  68,
  65,
  84,
  8,
  215,
  99,
  248,
  207,
  192,
  240,
  31,
  0,
  5,
  0,
  1,
  255,
  137,
  153,
  61,
  29,
  0,
  0,
  0,
  0,
  73,
  69,
  78,
  68,
  174,
  66,
  96,
  130,
]);
