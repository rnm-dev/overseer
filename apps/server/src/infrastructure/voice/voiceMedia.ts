// What the client is allowed to record, and what filename we hand the provider.
//
// Whisper-family HTTP APIs infer the container from the uploaded filename, not
// from the part's Content-Type, so every accepted media type needs an extension
// the provider recognises. The client sends whatever MediaRecorder produced —
// `audio/webm;codecs=opus` on Chrome/Firefox/Android, `audio/mp4` on Safari and
// the Flutter recorder — and never transcodes.
const MEDIA_TYPE_EXTENSIONS: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/opus": "ogg",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "m4a",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/flac": "flac",
  // Safari has been known to label a recording video/mp4 even with no video
  // track, which is why the raw-body matcher accepts it alongside audio/*.
  "video/mp4": "mp4",
  "video/webm": "webm",
};

export const VOICE_MEDIA_TYPES = Object.keys(MEDIA_TYPE_EXTENSIONS);

// "audio/webm;codecs=opus" → "audio/webm". Parameters carry the codec, which
// the provider reads out of the container itself.
export function normalizeMediaType(raw: string | undefined): string {
  return (raw ?? "").split(";", 1)[0].trim().toLowerCase();
}

export function isSupportedMediaType(raw: string | undefined): boolean {
  return normalizeMediaType(raw) in MEDIA_TYPE_EXTENSIONS;
}

export function audioFileName(raw: string | undefined): string {
  return `dictation.${MEDIA_TYPE_EXTENSIONS[normalizeMediaType(raw)] ?? "webm"}`;
}
