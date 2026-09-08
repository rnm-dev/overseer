# Peon Desktop for Windows

Work in progress under **Peon Desktop for Windows 0.1.0**. The application is
not released or ready for daily use. The current `apps/desktop` implementation
is an initial Tauri controller with inherited-pipe startup, status, connection
settings, pairing, restart/quit, Windows login startup and bounded lifecycle
logs. The runtime is bundled. Windows execution and the remaining native
portability work are not yet validated; this is a preview, not a supported
Windows release.

## Delivery scope

The operator requested a lean, usable Windows installer on 2026-09-08. The
first delivery should contain the existing compiled Node.js Peon and a small
Tauri controller. Use plain local HTML/CSS/JavaScript; a frontend framework,
local database, separate dashboard and generalized plugin architecture are
unnecessary for this controller.

Essential actions are start, stop/restart, enrollment, connection/activity
status, bounded diagnostics, start at login and Open Overseer. Closing the
window leaves the tray running. Explicit quit stops its owned daemon after
graceful shutdown. Run as the interactive user, without elevation, WSL or a
Windows Service. Ship a per-user NSIS `.exe` installer with a pinned runtime.

Advanced usage views and an automatic update channel are follow-on work for
the lean first installer. Manual upgrades must still preserve data and must
not run concurrently with Peon's npm updater. This reduced UI scope does not
remove the runtime, filesystem or process-safety requirements.

## Runtime boundary

Peon owns identity, enrollment, settings, sessions, transcripts, provider
credentials and execution. The controller must never read/write those private
files. Controller-owned preferences are limited to presentation and startup.

The implementation uses inherited anonymous pipes for the controller/daemon bridge, with a small
versioned request/reply protocol and a fixed command allowlist. The inherited
handles establish the local capability; no extra network listener or stored
shared token is needed. Bound frames, outstanding requests and deadlines, and
fence replies by process generation. The renderer only calls typed Tauri
commands, never an arbitrary shell/file/network proxy.

The daemon must wait for the parent's initial handshake before starting any
agent processes. On Windows the controller must attach it to a Job Object
before that handshake; closing the job terminates owned descendants. Normal
shutdown uses the bridge so Peon flushes durable state before any forced
termination. A occupied port or existing Peon is a conflict to explain, not
permission to kill or adopt an unrelated process.

The desktop must use the existing [enrollment flow](peon-cli-only.md) and
[Fleet HTTP transport](remaining-peon-http-control-plane.md). A connected
outbound socket does not prove that Overseer can enroll or operate the Peon.
Onboarding must describe the required reachable mesh address and firewall
setup. Provider login remains separate from enrollment.

## Implementation and release gates

- OVSR-416: controller contract and tested Windows support matrix.
- OVSR-415: tray shell and build integration.
- OVSR-546: native bootstrap, state paths and private Windows permissions.
- OVSR-547: native contained filesystem operations; retain existing safety.
- OVSR-549: inherited-pipe bridge and authoritative service adapters.
- OVSR-414 / OVSR-413: runtime packaging and lifecycle/process-tree cleanup.
- OVSR-548: real provider/tool launch, login, cancellation and recovery.
- OVSR-417 / OVSR-418 / OVSR-419: status, enrollment, settings and diagnostics.
- OVSR-421 / OVSR-423: installer, Windows validation and release evidence.

No Windows version or architecture is claimed supported until tested. The
initial build target is `x86_64-pc-windows-msvc`. Compile success alone does
not establish installer, login, filesystem or process-lifecycle correctness.

Before delivery, validate clean installation without global Node, one complete
agent session and follow-up, enrollment and a Fleet operation, file mutation
containment, child/grandchild cleanup, crash/restart, login autostart, upgrade
with identity/transcripts preserved, and uninstall. Record exact versions and
checksums. Signing requires an available signing identity; do not label an
unsigned artifact signed or promise SmartScreen reputation.

## Implemented protocol

`apps/peon/src/desktop/peon.ts` is the compiled desktop daemon entry point.
It waits for `initialize` with `{protocol: 1}` before importing the normal
daemon. It then exposes `status`, `configure`, `enroll` and `shutdown` through
Peon's own services. Configuration accepts only name, connection URLs, default
agent and agent executable paths. Peon validates the values. Status deliberately
omits enrollment/provider secrets and transcript content.

Frames are newline-delimited JSON, at most 64 KiB, with integer request IDs.
There are at most 16 pending requests. The Rust controller serializes requests
and checks matching reply IDs. Startup has a 90-second deadline; ordinary
requests have bounded deadlines. End-of-pipe invokes daemon shutdown.
Running sessions require an explicit force confirmation before restart/quit.

Desktop mode sets `PEON_DESKTOP=1` before loading Peon. Local and Fleet update
apply/check reject independent package updates with `DESKTOP_MANAGED`; install
a newer desktop bundle manually instead. The desktop currently exposes only
bounded controller lifecycle logs, not raw provider or daemon output.

## Remaining work before ready-to-use delivery

- Real Windows installer/UI, login startup and Job Object lifecycle validation.
- Native Windows secure filesystem operations (OVSR-547); existing Unix helpers
  still reject Windows. No containment checks have been weakened.
- Windows agent execution/login and `.cmd` launcher compatibility (OVSR-548).
- Windows private state permissions and complete lifecycle/coexistence audit
  (OVSR-546/OVSR-413); no claim of full Windows support in the npm manifest.
- Installer upgrade/uninstall, signing and release evidence.
- Automatic crash recovery and richer agent-readiness status remain unfinished.

The inherited-pipe unit tests and an isolated packaged-runtime smoke test pass
on macOS using the host Node. The smoke test covers handshake, settings
persistence through restart, pairing, secret redaction, desktop update refusal
and graceful shutdown. This is not Windows runtime evidence.

## Build setup

The monorepo workspace is `apps/desktop`, with Rust in `src-tauri` and plain
web assets in `ui`. Run `npm install` from the repository root. Stage the pinned
Windows Node 22.22.0 binary and compiled Peon before building:

```sh
npm run stage -w @rnm-dev/peon-desktop
npm run build -w @rnm-dev/peon-desktop
```

The stage command verifies the Node binary against its official SHA-256 and
includes its license. It compiles and packs local Peon, installs production
dependencies with dependency lifecycle scripts disabled, and records bundle
versions. Runtime resources and Rust build output are gitignored. Test the
packaged JavaScript with host Node using
`node apps/desktop/scripts/smoke-runtime.mjs`; it isolates config/state/data in
a temporary directory and does not restart the installed Peon.

Building on Windows is preferred. Tauri also documents an NSIS
[cross-compilation route](https://v2.tauri.app/distribute/windows-installer/)
from macOS. This requires the Windows Rust target, cargo-xwin, LLVM, LLD and
NSIS; it still requires a Windows host for runtime validation.

```sh
rustup target add x86_64-pc-windows-msvc
cargo install --locked cargo-xwin
brew install nsis llvm lld
PATH=/opt/homebrew/opt/llvm/bin:/opt/homebrew/opt/lld/bin:$PATH \
  npm run build -w @rnm-dev/peon-desktop -- \
  --runner cargo-xwin --target x86_64-pc-windows-msvc
```

The Mac used for initial development has UTM installed, but `utmctl list`
reported no configured virtual machines. No Windows validation host has been
established. Existing Linux/macOS Peon deployments must retain their current
[account](peon-user-account.md) and [update](peon-update-channel.md) behavior.
