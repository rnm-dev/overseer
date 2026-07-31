export function backgroundSupervisor(sourceCheckout, platform = process.platform) {
    return sourceCheckout || platform === "darwin" ? "detached" : "systemd";
}
