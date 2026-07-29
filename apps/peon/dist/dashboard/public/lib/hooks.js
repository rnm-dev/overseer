(function () {
  const { useEffect, useRef, useState, useCallback } = React;
  const { apiGet, API_BASE } = window.ACA;

  function useInterval(callback, ms) {
    const savedRef = useRef(callback);
    savedRef.current = callback;
    useEffect(() => {
      const id = setInterval(() => savedRef.current(), ms);
      return () => clearInterval(id);
    }, [ms]);
  }

  function useStatus() {
    const [status, setStatus] = useState(null);
    const [reachable, setReachable] = useState(true);

    const refresh = useCallback(async () => {
      try {
        const { body } = await apiGet("/api/v1/status");
        setStatus(body);
        setReachable(true);
      } catch {
        setReachable(false);
      }
    }, []);

    useEffect(() => {
      refresh();
    }, [refresh]);
    useInterval(refresh, 4000);

    return { status, reachable, refresh };
  }

  // `name` setting, live-synced app-wide (SSE "settings" event) — drives the
  // dashboard tab title. Separate from useStatus/its 4s poll since a name
  // edit should reflect immediately, not on the next poll tick.
  function useSettings() {
    const [settings, setSettings] = useState(null);

    useEffect(() => {
      apiGet("/api/v1/settings").then(({ body }) => setSettings(body));
      const events = new EventSource(`${API_BASE}/api/v1/events`, { withCredentials: true });
      events.addEventListener("settings", (e) => setSettings(JSON.parse(e.data)));
      return () => events.close();
    }, []);

    return settings;
  }

  // While `active`, cycles the tab title through an ASCII spinner; otherwise
  // holds it at `idleTitle`. Both branches write document.title directly
  // (rather than restoring some title snapshot) so the "idle" side stays
  // correct even if it changes (e.g. the peon name setting) while mounted.
  function useTitleSpinner(active, workingLabel, idleTitle) {
    useEffect(() => {
      if (!active) {
        document.title = idleTitle;
        return;
      }
      const frames = ["|", "/", "-", "\\"];
      let i = 0;
      document.title = `${frames[0]} ${workingLabel}`;
      const id = setInterval(() => {
        i = (i + 1) % frames.length;
        document.title = `${frames[i]} ${workingLabel}`;
      }, 200);
      return () => {
        clearInterval(id);
        document.title = idleTitle;
      };
    }, [active, workingLabel, idleTitle]);
  }

  function currentPathView(defaultView) {
    return window.location.pathname.replace(/^\//, "") || defaultView;
  }

  // URL-path-backed view state — bookmarkable/back-button-friendly without
  // pulling in a router for a 3-tab dashboard.
  function usePathView(defaultView) {
    const [view, setView] = useState(() => currentPathView(defaultView));

    useEffect(() => {
      const onPopState = () => setView(currentPathView(defaultView));
      window.addEventListener("popstate", onPopState);
      return () => window.removeEventListener("popstate", onPopState);
    }, [defaultView]);

    const navigate = useCallback((next) => {
      const path = "/" + next;
      // pushState doesn't fire popstate, so update state directly here
      // rather than waiting for an event that will never come.
      if (path !== window.location.pathname) window.history.pushState(null, "", path);
      setView(next);
    }, []);

    return [view, navigate];
  }

  function isPlainLeftClick(e) {
    return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
  }

  Object.assign(window.ACA, {
    useInterval,
    useStatus,
    useSettings,
    usePathView,
    isPlainLeftClick,
    useTitleSpinner,
  });
})();
