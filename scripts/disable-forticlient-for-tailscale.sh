#!/usr/bin/env bash
set -euo pipefail

VPN_SERVICE="VPN"
TAILSCALE_PEER="100.64.0.1"
USER_ID="$(id -u)"

if [[ "${1:-off}" == "on" ]]; then
  echo "Re-enabling the FortiClient VPN service..."
  sudo networksetup -setnetworkserviceenabled "$VPN_SERVICE" on
  sudo launchctl bootstrap system /Library/LaunchDaemons/com.fortinet.forticlient.vpnctl2.plist 2>/dev/null || true
  sudo launchctl bootstrap system /Library/LaunchDaemons/com.fortinet.forticlient.vpn.plist 2>/dev/null || true
  launchctl bootstrap "gui/$USER_ID" /Library/LaunchAgents/com.fortinet.forticlient.fct_launcher.plist 2>/dev/null || true
  open -a FortiClient
  echo "FortiClient VPN service re-enabled."
  exit 0
fi

if [[ "${1:-off}" != "off" ]]; then
  echo "Usage: $0 [off|on]" >&2
  exit 64
fi

echo "This disables FortiClient VPN without uninstalling it or deleting profiles."
sudo -v

echo "Stopping any active FortiClient VPN session..."
scutil --nc stop "$VPN_SERVICE" 2>/dev/null || true

echo "Disabling the FortiClient VPN network service..."
sudo networksetup -setnetworkserviceenabled "$VPN_SERVICE" off

echo "Stopping FortiClient VPN controllers and user agents..."
sudo launchctl bootout system/com.fortinet.vpnctl 2>/dev/null || true
sudo launchctl bootout system/com.fortinet.fctctl 2>/dev/null || true
launchctl bootout "gui/$USER_ID/com.fortinet.fct_launcher" 2>/dev/null || true
launchctl bootout "gui/$USER_ID/com.fortinet.fortiagent" 2>/dev/null || true

sudo pkill -f '/Applications/FortiClient.app/.*FortiClientNetwork' 2>/dev/null || true
sudo pkill -f '/Library/Application Support/Fortinet/FortiClient/bin/vpnctl2' 2>/dev/null || true
pkill -x FortiTray 2>/dev/null || true
pkill -x FortiClientAgent 2>/dev/null || true

echo "Restarting Tailscale..."
sudo launchctl kickstart -k system/com.tailscale.tailscaled
sleep 3

echo
echo "Network services (* means disabled):"
networksetup -listallnetworkservices | grep -E '^\*?VPN$' || true

echo
echo "FortiClient system-extension registration (registration may remain while its service is disabled):"
systemextensionsctl list 2>/dev/null | grep -i fortinet || true

echo
echo "Tailscale path test:"
tailscale ping -c 10 "$TAILSCALE_PEER" || true

echo
echo "Done. To restore FortiClient later, run:"
printf '  sudo %q on\n' "$0"
