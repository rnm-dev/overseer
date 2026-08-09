export const PATH_ESCAPE_PUBLIC_MESSAGE = "the requested file is outside the allowed file area";

export function auditSafeFileErrorMessage(code: string, message: string): string {
  return code === "PATH_ESCAPE" ? PATH_ESCAPE_PUBLIC_MESSAGE : message;
}

export function auditSafeFileErrorBody(error: { code: string; message: string }): { error: string; code: string } {
  return {
    error: auditSafeFileErrorMessage(error.code, error.message),
    code: error.code,
  };
}
