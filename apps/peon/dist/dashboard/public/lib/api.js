(function () {
  // Control and dashboard are two separate servers/ports by design (4570/4571).
  //
  // Direct access — loopback (127.0.0.1:4571) or a LAN/remote box IP on the
  // dashboard's own port — means the browser reaches each server by port, so the
  // control API has to be addressed at its sibling port on the same host. A plain
  // relative path wouldn't work there (it'd hit the dashboard, not the API).
  //
  // Behind a reverse proxy on a domain, though, the dashboard is served
  // same-origin (typically :443/:80, no explicit port) and the proxy routes
  // /api/v1/* to the control API. There we must NOT append :4570 — the port isn't
  // reachable from outside and the proxy already fronts both. Detect that case by
  // the absence of the dashboard's own direct port and fall back to a same-origin
  // relative base.
  const DASHBOARD_PORT = "4571";
  const API_BASE =
    window.location.port === DASHBOARD_PORT
      ? `${window.location.protocol}//${window.location.hostname}:4570`
      : "";

  const unauthorizedListeners = new Set();
  function onUnauthorized(cb) {
    unauthorizedListeners.add(cb);
    return () => unauthorizedListeners.delete(cb);
  }
  function notifyUnauthorized() {
    unauthorizedListeners.forEach((cb) => cb());
  }

  async function apiGet(path) {
    const res = await fetch(`${API_BASE}${path}`, { credentials: "include" });
    if (res.status === 401) notifyUnauthorized();
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body };
  }

  async function apiPost(path, body) {
    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      credentials: "include",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) notifyUnauthorized();
    const responseBody = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body: responseBody };
  }

  async function apiPatch(path, body) {
    const res = await fetch(`${API_BASE}${path}`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 401) notifyUnauthorized();
    const responseBody = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body: responseBody };
  }

  async function apiPut(path, body) {
    const res = await fetch(`${API_BASE}${path}`, { method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (res.status === 401) notifyUnauthorized();
    const responseBody = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body: responseBody };
  }

  async function apiDelete(path) {
    const res = await fetch(`${API_BASE}${path}`, { method: "DELETE", credentials: "include" });
    if (res.status === 401) notifyUnauthorized();
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body };
  }

  // fetch() can't portably report upload progress — only XHR's
  // xhr.upload.onprogress can. Used only when a request actually carries
  // file attachments; apiPost above stays on fetch() for everything else.
  function apiUpload(path, formData, onProgress) {
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${API_BASE}${path}`);
      xhr.withCredentials = true;
      xhr.upload.onprogress = (e) => {
        if (onProgress && e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => {
        if (xhr.status === 401) notifyUnauthorized();
        let body = {};
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          // non-JSON error page — leave body as {}
        }
        resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, body });
      };
      xhr.onerror = () => resolve({ ok: false, status: 0, body: { error: "network error" } });
      xhr.send(formData);
    });
  }

  Object.assign(window.ACA, { API_BASE, apiGet, apiPost, apiPatch, apiPut, apiDelete, apiUpload, onUnauthorized });
})();
