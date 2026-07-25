enum SoundPack {
  peon('peon', 'Peon', 'sounds/peon/work-start.wav'),
  scv('sc_scv', 'SCV', 'sounds/sc_scv/work-start.mp3'),
  peasant('peasant', 'Peasant', 'sounds/peasant/work-start.wav'),
  mute('none', 'Mute', null);

  const SoundPack(this.id, this.label, this.previewAsset);

  final String id;
  final String label;
  final String? previewAsset;

  static SoundPack fromId(String? id) {
    return SoundPack.values.firstWhere(
      (pack) => pack.id == id,
      orElse: () => SoundPack.peon,
    );
  }
}
