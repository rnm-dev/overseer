// The running build's version, stated once and served from /healthz so an
// operator can answer "what is deployed here" without shell access to the host.
//
// A literal rather than a read of package.json: the compiled layout puts dist/
// and the manifests at different depths than the source tree, so any relative
// read is correct in one of the two and silently wrong in the other. The test
// beside this file keeps the literal in step with apps/server/package.json,
// which is what the release process actually bumps.
export const SERVER_VERSION = "0.5.0";
