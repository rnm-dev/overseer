export type BackgroundSupervisor = "detached" | "systemd";

export function backgroundSupervisor(
  sourceCheckout: boolean,
  platform: NodeJS.Platform = process.platform,
): BackgroundSupervisor {
  return sourceCheckout || platform === "darwin" ? "detached" : "systemd";
}
