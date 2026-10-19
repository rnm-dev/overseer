import { ARMORY_PROJECT_PACKAGES_CAPABILITY, type ArmoryConfiguration, type ArmoryOperation, type ArmoryProfile, type ArmoryProfileOperation, type ArmoryProfileReadiness, type ArmoryProfileRequirement } from "./armoryTypes";

export function supportsArmoryProjectPackages(capabilities: string[] | null | undefined): boolean {
  return capabilities?.includes(ARMORY_PROJECT_PACKAGES_CAPABILITY) === true;
}

export function matchingArmoryProfiles(profiles: ArmoryProfile[], requirement: ArmoryProfileRequirement): ArmoryProfile[] {
  return profiles.filter((profile) => profile.type === requirement.type);
}

export function missingArmoryProfileFields(profile: ArmoryProfile, requirement: ArmoryProfileRequirement): string[] {
  return requirement.requiredFields.filter((field) => profile.configuredFields[field] !== true);
}

export function armoryProfileReadiness(profile: ArmoryProfile, requirement: ArmoryProfileRequirement): ArmoryProfileReadiness {
  if (profile.type !== requirement.type) return "type_mismatch";
  if (missingArmoryProfileFields(profile, requirement).length > 0 || profile.status === "missing") return "missing_fields";
  if (profile.status === "invalid") return "invalid";
  if (profile.status !== "verified") return "unverified";
  return "ready";
}

export function isMcpCapable(value: { capabilities?: Record<string, boolean> | null } | null | undefined): boolean {
  return value?.capabilities?.mcp === true;
}

export function activeArmoryCapabilities(value: { capabilities?: Record<string, boolean> | null } | null | undefined): string[] {
  return Object.entries(value?.capabilities ?? {}).filter(([, enabled]) => enabled === true).map(([name]) => name);
}

export function armoryOperationProgress(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(100, value))
    : null;
}

export type ConfigurationErrors = Record<string, string>;

// Client checks improve feedback only; Peon remains authoritative. Messages
// deliberately identify fields/rules without interpolating entered values.
export function validateArmoryConfiguration(schema: ArmoryConfiguration, values: Record<string, string>): ConfigurationErrors {
  const errors: ConfigurationErrors = {};
  for (const field of schema.fields) {
    const value = values[field.id] ?? "";
    if (field.required && value.length === 0) {
      errors[field.id] = `${field.label} is required.`;
      continue;
    }
    if (!value) continue;
    if (field.type === "select" && !field.options?.some((option) => option.value === value)) {
      errors[field.id] = `Choose a declared option for ${field.label}.`;
      continue;
    }
    if (field.validation?.maxLength !== undefined && value.length > field.validation.maxLength) {
      errors[field.id] = `${field.label} must be at most ${field.validation.maxLength} characters.`;
      continue;
    }
    if (field.validation?.pattern) {
      try {
        if (!new RegExp(field.validation.pattern).test(value)) errors[field.id] = `${field.label} does not match the required format.`;
      } catch {
        // A malformed manifest pattern must not break configuration. Peon will
        // return MANIFEST_INVALID or authoritative field validation.
      }
    }
  }
  return errors;
}

export function validateArmoryProfileConfiguration(schema: ArmoryConfiguration, profile: ArmoryProfile, values: Record<string, string>): ConfigurationErrors {
  const errors = validateArmoryConfiguration(schema, values);
  for (const field of schema.fields) {
    if (field.required && profile.configuredFields[field.id] === true && (values[field.id] ?? "") === "") delete errors[field.id];
  }
  return errors;
}

// Secret and file values are single-use UI state. Once Peon accepts a
// replacement request, only ordinary values may remain while its operation is
// polled. Configured flags are deliberately not turned into replacement values.
export function clearAcceptedTransientValues(schema: ArmoryConfiguration, values: Record<string, string>): Record<string, string> {
  const transientIds = new Set(schema.fields.filter((field) => field.type === "secret" || field.type === "file").map((field) => field.id));
  return Object.fromEntries(Object.entries(values).filter(([id]) => !transientIds.has(id)));
}

export function operationActive(operation: Pick<ArmoryOperation | ArmoryProfileOperation, "status"> | null): boolean {
  return operation?.status === "queued" || operation?.status === "running";
}
