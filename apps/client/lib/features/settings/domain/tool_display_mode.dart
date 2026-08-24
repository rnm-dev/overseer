enum ToolDisplayMode {
  simple('simple', 'Simple'),
  technical('technical', 'Technical');

  const ToolDisplayMode(this.id, this.label);

  final String id;
  final String label;

  static ToolDisplayMode fromId(String? id) => id == ToolDisplayMode.simple.id
      ? ToolDisplayMode.simple
      : ToolDisplayMode.technical;
}
