import { useEffect, useRef, useState } from "react";
import { Button } from "../../shared/ui";
import type { ArmoryProfileIdentity } from "./armoryApi";

// Stored profile values are write-only, but the address the credential acts as
// is not a secret — it is the thing an operator has to paste into Google to
// grant the service account access. Show it wherever package configuration is
// shown, and make copying it one click.
export function ArmoryIdentityRow({ identity, className = "" }: {
  identity: ArmoryProfileIdentity | null | undefined;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => { if (timer.current !== undefined) window.clearTimeout(timer.current); }, []);
  if (!identity) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(identity.value);
      setCopied(true);
      if (timer.current !== undefined) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch { setCopied(false); }
  };

  return <div className={className}>
    <p className="font-mono text-xs text-ink-faint">{identity.label}</p>
    <div className="mt-1 flex flex-wrap items-center gap-2">
      <span className="min-w-0 break-all font-mono text-sm text-ink" data-testid="armory-identity-value">{identity.value}</span>
      <Button type="button" size="sm" variant="secondary" onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</Button>
    </div>
    <p className="mt-1 text-xs text-ink-muted">Grant this address access to the resources the package should reach.</p>
  </div>;
}
