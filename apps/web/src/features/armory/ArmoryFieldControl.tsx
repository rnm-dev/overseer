import { useEffect, useId, useRef, useState, type ChangeEvent } from "react";
import { Badge } from "../../shared/ui";
import type { ArmoryConfigurationField } from "./armoryTypes";

// One write-only configuration field, shared by package configuration
// ("package") and credential profiles ("profile"). The variants differ only in
// spacing, the configured badge layout, and whether a configured value still
// counts as required.
export function ArmoryFieldControl({ variant, name, field, value, error, configured, disabled, onValue }: {
  variant: "package" | "profile";
  name?: string;
  field: ArmoryConfigurationField;
  value: string;
  error?: string;
  configured: boolean;
  disabled: boolean;
  onValue: (value: string) => void;
}) {
  const id = useId();
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const pkg = variant === "package";
  const describedBy = [field.help ? helpId : "", error ? errorId : ""].filter(Boolean).join(" ") || undefined;
  const common = { id, disabled, required: pkg ? field.required : field.required && !configured, "aria-describedby": describedBy, "aria-invalid": Boolean(error) };
  const fileInput = useRef<HTMLInputElement>(null);
  const [userActivated, setUserActivated] = useState(false);
  const pad = (wide: string) => (pkg && configured ? ` ${wide}` : "");

  useEffect(() => { if (!value && fileInput.current) fileInput.current.value = ""; }, [value]);

  const readFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) { onValue(""); return; }
    try { onValue(await file.text()); }
    catch { onValue(""); }
  };

  return (
    <div className={`grid gap-2 border-b border-edge last:border-b-0 last:pb-0 sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] ${pkg ? "pb-5 sm:gap-6" : "pb-4 sm:gap-5"}`}>
      <div>
        <label htmlFor={id} className="font-display text-xs font-bold text-ink">{field.label}{field.required && <span className="ml-1 text-warning-strong" aria-label="required">*</span>}</label>
        {field.help && <p id={helpId} className={`${pkg ? "mt-1.5" : "mt-1"} text-xs leading-relaxed text-ink-muted`}>{field.help}</p>}
      </div>
      <div className={pkg ? "min-w-0" : undefined}>
        <div className="relative">
          {field.type === "select" ? (
            <select {...common} name={name} autoComplete={pkg ? "off" : undefined} className={`field w-full${pad("pr-44")}`} value={value} onChange={(event) => onValue(event.target.value)}>
              <option value="">Select…</option>
              {(field.options ?? []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          ) : field.type === "file" ? (
            <input {...common} ref={fileInput} name={name} autoComplete={pkg ? "off" : undefined} className={`field w-full file:mr-3 file:border-0 file:bg-surface-hover file:px-3 file:py-1 file:text-ink${pad("pr-40")}`} type="file" onChange={(event) => void readFile(event)} />
          ) : (
            <input
              {...common}
              name={name}
              autoComplete={field.type === "secret" ? "new-password" : "off"}
              data-1p-ignore="true"
              data-lpignore="true"
              data-form-type="other"
              readOnly={!userActivated}
              onFocus={() => setUserActivated(true)}
              className={`field w-full${pad("pr-40")}`}
              type={field.type === "secret" ? "password" : "text"}
              value={value}
              onChange={(event) => onValue(event.target.value)}
              pattern={field.validation?.pattern}
              maxLength={field.validation?.maxLength}
            />
          )}
          {configured && (pkg
            ? <div className={`pointer-events-none absolute top-1/2 flex -translate-y-1/2 gap-1.5 ${field.type === "select" ? "right-8" : "right-3"}`}><Badge>Configured</Badge></div>
            : <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2"><Badge>Configured</Badge></span>)}
        </div>
        {pkg && field.validation && <p className="mt-1 font-mono text-[0.68rem] text-ink-faint">{field.validation.maxLength !== undefined ? `Maximum ${field.validation.maxLength} characters. ` : ""}{field.validation.pattern ? "A package-defined format is required." : ""}</p>}
        {error && <p id={errorId} role="alert" className="mt-1 text-xs text-danger">{error}</p>}
      </div>
    </div>
  );
}
