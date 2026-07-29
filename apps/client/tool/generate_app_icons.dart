import 'dart:io';

import 'package:image/image.dart' as image;

const _sourcePath = 'assets/images/app-icon.png';

const _androidIcons = <String, int>{
  'android/app/src/main/res/mipmap-mdpi/ic_launcher.png': 48,
  'android/app/src/main/res/mipmap-mdpi/ic_launcher_overseer.png': 48,
  'android/app/src/main/res/mipmap-hdpi/ic_launcher.png': 72,
  'android/app/src/main/res/mipmap-hdpi/ic_launcher_overseer.png': 72,
  'android/app/src/main/res/mipmap-xhdpi/ic_launcher.png': 96,
  'android/app/src/main/res/mipmap-xhdpi/ic_launcher_overseer.png': 96,
  'android/app/src/main/res/mipmap-xxhdpi/ic_launcher.png': 144,
  'android/app/src/main/res/mipmap-xxhdpi/ic_launcher_overseer.png': 144,
  'android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png': 192,
  'android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_overseer.png': 192,
};

const _iosIcons = <String, int>{
  'ios/Runner/Assets.xcassets/AppIcon.appiconset/Icon-App-20x20@1x.png': 20,
  'ios/Runner/Assets.xcassets/AppIcon.appiconset/Icon-App-20x20@2x.png': 40,
  'ios/Runner/Assets.xcassets/AppIcon.appiconset/Icon-App-20x20@3x.png': 60,
  'ios/Runner/Assets.xcassets/AppIcon.appiconset/Icon-App-29x29@1x.png': 29,
  'ios/Runner/Assets.xcassets/AppIcon.appiconset/Icon-App-29x29@2x.png': 58,
  'ios/Runner/Assets.xcassets/AppIcon.appiconset/Icon-App-29x29@3x.png': 87,
  'ios/Runner/Assets.xcassets/AppIcon.appiconset/Icon-App-40x40@1x.png': 40,
  'ios/Runner/Assets.xcassets/AppIcon.appiconset/Icon-App-40x40@2x.png': 80,
  'ios/Runner/Assets.xcassets/AppIcon.appiconset/Icon-App-40x40@3x.png': 120,
  'ios/Runner/Assets.xcassets/AppIcon.appiconset/Icon-App-60x60@2x.png': 120,
  'ios/Runner/Assets.xcassets/AppIcon.appiconset/Icon-App-60x60@3x.png': 180,
  'ios/Runner/Assets.xcassets/AppIcon.appiconset/Icon-App-76x76@1x.png': 76,
  'ios/Runner/Assets.xcassets/AppIcon.appiconset/Icon-App-76x76@2x.png': 152,
  'ios/Runner/Assets.xcassets/AppIcon.appiconset/Icon-App-83.5x83.5@2x.png':
      167,
  'ios/Runner/Assets.xcassets/AppIcon.appiconset/'
          'Icon-App-1024x1024@1x.png':
      1024,
};

const _macosIcons = <String, int>{
  'macos/Runner/Assets.xcassets/AppIcon.appiconset/app_icon_16.png': 16,
  'macos/Runner/Assets.xcassets/AppIcon.appiconset/app_icon_32.png': 32,
  'macos/Runner/Assets.xcassets/AppIcon.appiconset/app_icon_64.png': 64,
  'macos/Runner/Assets.xcassets/AppIcon.appiconset/app_icon_128.png': 128,
  'macos/Runner/Assets.xcassets/AppIcon.appiconset/app_icon_256.png': 256,
  'macos/Runner/Assets.xcassets/AppIcon.appiconset/app_icon_512.png': 512,
  'macos/Runner/Assets.xcassets/AppIcon.appiconset/app_icon_1024.png': 1024,
};

void main() {
  final source = image.decodePng(File(_sourcePath).readAsBytesSync());
  if (source == null) {
    throw StateError('Could not decode $_sourcePath.');
  }
  if (source.width != source.height) {
    throw StateError('App icon source must be square.');
  }

  _writeIcons(source, _androidIcons);
  _writeIcons(_opaqueCopy(source), _iosIcons);
  _writeIcons(source, _macosIcons);
}

void _writeIcons(image.Image source, Map<String, int> outputs) {
  for (final output in outputs.entries) {
    final resized = image.copyResize(
      source,
      width: output.value,
      height: output.value,
      interpolation: image.Interpolation.cubic,
    );
    File(output.key).writeAsBytesSync(image.encodePng(resized));
  }
}

image.Image _opaqueCopy(image.Image source) {
  final canvas = image.Image(
    width: source.width,
    height: source.height,
    numChannels: 3,
  );
  image.fill(canvas, color: image.ColorRgb8(17, 19, 17));
  image.compositeImage(canvas, source);
  return canvas;
}
