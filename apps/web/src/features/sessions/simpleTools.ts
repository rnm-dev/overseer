import { editFileName } from "./toolEdit";

export type SimpleToolKind = "read" | "search" | "web" | "edit" | "analysis" | "command" | "generic";

export function simpleToolKind(name: string | undefined): SimpleToolKind {
  switch (name?.trim().toLowerCase()) {
    case "read":
      return "read";
    case "grep":
    case "glob":
      return "search";
    case "webfetch":
    case "websearch":
      return "web";
    case "edit":
    case "write":
    case "notebookedit":
      return "edit";
    case "task":
    case "agent":
      return "analysis";
    case "bash":
      return "command";
    default:
      return "generic";
  }
}

export function simpleToolFileName(name: string | undefined, input: unknown): string | null {
  const kind = simpleToolKind(name);
  return kind === "read" || kind === "edit" || kind === "search" ? editFileName(input) : null;
}
