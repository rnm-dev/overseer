import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ApiError } from "./api";
import { useT } from "./i18n";

const TOAST_LIFETIME_MS = 10_000;
const MAX_VISIBLE_TOASTS = 4;

export interface ErrorToastOptions {
  title: string;
  fallback: string;
  /** A localized, action-specific explanation. The raw API message remains in details. */
  message?: string;
}

export interface ErrorToastContent {
  title: string;
  message: string;
  detail?: string;
  code?: string;
  status?: number;
  requestId?: string;
}

interface Toast extends ErrorToastContent {
  id: string;
}

interface NotificationsValue {
  notifyError: (error: unknown, options: ErrorToastOptions) => string;
  dismiss: (id: string) => void;
}

const NotificationsContext = createContext<NotificationsValue | null>(null);

export function isDuplicateErrorToast(left: ErrorToastContent, right: ErrorToastContent): boolean {
  return left.title === right.title
    && left.message === right.message
    && left.detail === right.detail
    && left.code === right.code
    && left.status === right.status;
}

export function errorToastContent(error: unknown, options: ErrorToastOptions): ErrorToastContent {
  const apiError = error instanceof ApiError ? error : null;
  const rawMessage = error instanceof Error ? error.message.trim() : "";
  const message = options.message?.trim() || rawMessage || options.fallback;
  const detail = options.message?.trim() && rawMessage && rawMessage !== message ? rawMessage : undefined;

  return {
    title: options.title,
    message,
    detail,
    code: apiError?.code && apiError.code !== "ERROR" ? apiError.code : undefined,
    status: apiError?.status || undefined,
    requestId: apiError?.requestId,
  };
}

function ErrorToast({ toast, dismiss }: { toast: Toast; dismiss: (id: string) => void }) {
  const t = useT();
  useEffect(() => {
    const timer = window.setTimeout(() => dismiss(toast.id), TOAST_LIFETIME_MS);
    return () => window.clearTimeout(timer);
  }, [dismiss, toast.id]);

  return (
    <section
      role="alert"
      data-toast="error"
      className="pointer-events-auto w-full overflow-hidden rounded-xl border border-danger/50 bg-surface/95 shadow-[0_18px_50px_rgba(0,0,0,0.55),0_0_28px_rgba(239,91,67,0.08)] backdrop-blur-md"
    >
      <div className="h-0.5 bg-danger" />
      <div className="flex items-start gap-3 p-4">
        <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-danger/10 font-mono text-sm text-danger" aria-hidden>!</span>
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-sm font-bold text-ink">{toast.title}</h2>
          <p className="mt-1 break-words text-sm leading-relaxed text-ink-muted">{toast.message}</p>
          {toast.detail && <p className="mt-1 break-words font-mono text-xs leading-relaxed text-danger/90">{toast.detail}</p>}
          {(toast.code || toast.status || toast.requestId) && (
            <dl className="mt-3 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[0.65rem] text-ink-faint">
              {toast.code && <div className="flex gap-1"><dt>{t("toast.code")}</dt><dd className="text-ink-muted">{toast.code}</dd></div>}
              {toast.status && <div className="flex gap-1"><dt>{t("toast.status")}</dt><dd className="text-ink-muted">{toast.status}</dd></div>}
              {toast.requestId && <div className="flex min-w-0 gap-1"><dt>{t("toast.requestId")}</dt><dd className="truncate text-ink-muted" title={toast.requestId}>{toast.requestId}</dd></div>}
            </dl>
          )}
        </div>
        <button
          type="button"
          onClick={() => dismiss(toast.id)}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-lg leading-none text-ink-faint transition-colors hover:bg-surface-hover hover:text-ink"
          aria-label={t("toast.dismiss")}
        >
          ×
        </button>
      </div>
    </section>
  );
}

function ToastViewport({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: string) => void }) {
  const viewport = (
    <div className="pointer-events-none fixed inset-x-3 top-[max(0.75rem,env(safe-area-inset-top))] z-[120] flex flex-col items-end gap-2 sm:left-auto sm:right-4 sm:w-[min(26rem,calc(100vw-2rem))]">
      {toasts.map((toast) => <ErrorToast key={toast.id} toast={toast} dismiss={dismiss} />)}
    </div>
  );
  return typeof document === "undefined" ? viewport : createPortal(viewport, document.body);
}

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: string) => setToasts((current) => current.filter((toast) => toast.id !== id)), []);
  const notifyError = useCallback((error: unknown, options: ErrorToastOptions) => {
    const id = crypto.randomUUID();
    const next = { id, ...errorToastContent(error, options) };
    setToasts((current) => current.some((toast) => isDuplicateErrorToast(toast, next))
      ? current
      : [...current, next].slice(-MAX_VISIBLE_TOASTS));
    return id;
  }, []);
  const value = useMemo(() => ({ notifyError, dismiss }), [dismiss, notifyError]);

  return (
    <NotificationsContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} dismiss={dismiss} />
    </NotificationsContext.Provider>
  );
}

export function useNotifications(): NotificationsValue {
  const value = useContext(NotificationsContext);
  if (!value) throw new Error("useNotifications must be used within NotificationsProvider");
  return value;
}
