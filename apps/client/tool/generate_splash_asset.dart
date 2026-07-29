import 'dart:io';
import 'dart:typed_data';

import 'package:image/image.dart' as image;

const _sourcePath = 'assets/images/overseer-logo.png';
const _outputPath = 'assets/images/overseer-splash.png';
const _canvasExtent = 1152;
const _markExtent = 680;

void main() {
  final sourceBytes = File(_sourcePath).readAsBytesSync();
  final source = image.decodePng(sourceBytes);
  if (source == null) {
    throw StateError('Could not decode $_sourcePath.');
  }

  final mark = image.copyResize(
    source,
    width: source.width >= source.height ? _markExtent : null,
    height: source.height > source.width ? _markExtent : null,
    interpolation: image.Interpolation.cubic,
  );
  final canvas = image.Image(
    width: _canvasExtent,
    height: _canvasExtent,
    numChannels: 4,
  );
  image.fill(canvas, color: image.ColorRgba8(0, 0, 0, 0));
  image.compositeImage(
    canvas,
    mark,
    dstX: (_canvasExtent - mark.width) ~/ 2,
    dstY: (_canvasExtent - mark.height) ~/ 2,
  );
  if (canvas.getPixel(0, 0).a != 0) {
    throw StateError('Splash padding must remain fully transparent.');
  }

  final encoded = Uint8List.fromList(image.encodePng(canvas));
  final generated = image.decodePng(encoded);
  if (generated == null || generated.getPixel(0, 0).a != 0) {
    throw StateError('Encoded splash padding must remain fully transparent.');
  }
  File(_outputPath).writeAsBytesSync(encoded);
}
