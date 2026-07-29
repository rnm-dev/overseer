// Generates per-user launchd agents for macOS. LaunchAgents are loaded again
// after every login, while KeepAlive makes launchd restart a crashed process.
function xml(value) {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&apos;");
}
export function buildLaunchAgent(opts) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(opts.label)}</string>
  <key>Description</key>
  <string>${xml(opts.description)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(opts.nodeBin)}</string>
    <string>${xml(opts.script)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(opts.peonHome)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>${opts.portName}</key>
    <string>${opts.port}</string>
    <key>PATH</key>
    <string>${xml(opts.pathEnv)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(opts.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(opts.stderrPath)}</string>
</dict>
</plist>
`;
}
