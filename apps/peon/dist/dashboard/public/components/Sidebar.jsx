(function () {
  const { Dot, NavLink, UpdateBanner, apiPost, Avatar } = window.ACA;

  // Real Heroicons outline paths (home / chat-bubble-left-right / cog-6-tooth)
  // — reused verbatim rather than hand-derived, since a wrong bezier control
  // point is invisible in code review and I can't render this to check.
  function Icon({ path, className }) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className}>
        {path}
      </svg>
    );
  }

  const NAV_ITEMS = [
    {
      id: "home",
      label: "Home",
      icon: (
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="m2.25 12 8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25"
        />
      ),
    },
    {
      id: "projects",
      label: "Projects",
      icon: (
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M3.75 9.776c.112-.017.227-.026.344-.026h15.812c.117 0 .232.009.344.026m-16.5 0a2.25 2.25 0 0 0-1.883 2.542l.857 6a2.25 2.25 0 0 0 2.227 1.932H19.05a2.25 2.25 0 0 0 2.227-1.932l.857-6a2.25 2.25 0 0 0-1.883-2.542m-16.5 0V6A2.25 2.25 0 0 1 6 3.75h3.879a1.5 1.5 0 0 1 1.06.44l2.122 2.12a1.5 1.5 0 0 0 1.06.44H18A2.25 2.25 0 0 1 20.25 9v.776"
        />
      ),
    },
    {
      id: "sessions",
      label: "Sessions",
      icon: (
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M20.25 8.511c.884.284 1.5 1.128 1.5 2.097v4.286c0 1.136-.847 2.1-1.98 2.193-.34.027-.68.052-1.02.072v3.091l-3-3c-1.354 0-2.694-.055-4.02-.163a2.115 2.115 0 0 1-.825-.242m9.345-8.334a2.126 2.126 0 0 0-.476-.095 48.64 48.64 0 0 0-8.048 0c-1.131.094-1.976 1.057-1.976 2.192v4.286c0 .837.46 1.58 1.155 1.951m9.345-8.334V6.637c0-1.621-1.152-3.026-2.76-3.235A48.455 48.455 0 0 0 11.25 3c-2.115 0-4.198.137-6.24.402-1.608.209-2.76 1.614-2.76 3.235v6.226c0 1.621 1.152 3.026 2.76 3.235.577.075 1.157.14 1.74.194V21l4.155-4.155"
        />
      ),
    },
    {
      id: "overseer",
      label: "Overseer",
      // Heroicons outline "signal" — a peon phoning home to a fleet control plane.
      icon: (
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M9.348 14.652a3.75 3.75 0 0 1 0-5.304m5.304 0a3.75 3.75 0 0 1 0 5.304m-7.425 2.121a6.75 6.75 0 0 1 0-9.546m9.546 0a6.75 6.75 0 0 1 0 9.546M5.106 18.894c-3.808-3.807-3.808-9.98 0-13.788m13.788 0c3.808 3.807 3.808 9.98 0 13.788M12 12h.008v.008H12V12Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z"
        />
      ),
      // A rejected credential (overseer answered 401) degrades the fleet link — flag
      // it here the same way the AI tab's broken-auth warns on Settings.
      warn: (status) => status?.overseer?.derecruited === true,
    },
    {
      id: "settings",
      label: "Settings",
      icon: (
        <>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 0 1 0 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 0 1 0-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.127.332-.184.582-.496.644-.87l.214-1.28Z"
          />
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
        </>
      ),
      // AI moved under Settings, so a broken Claude Code auth
      // (surfaced on the AI tab there) now warns on the Settings item.
      warn: (status) => status?.claudeCodeAuthState === "broken",
    },
  ];

  async function logout() {
    await apiPost("/api/v1/auth/logout");
    window.location.reload();
  }

  // Who currently has the dashboard open, on any page — not to be confused
  // with a session's own "N viewing" badge (SessionsCard.jsx), which is
  // scoped to one session's detail page. Full usernames go in the tooltip
  // rather than inline, so this stays a one-line footprint regardless of
  // how many people are on.
  function ActiveUsers({ users }) {
    if (!users || users.length === 0) return null;
    return (
      <span className="text-slate-600" title={users.join(", ")}>
        {users.length} online
      </span>
    );
  }

  // Desktop keeps the full vertical sidebar. Below md, that becomes two
  // pieces instead: a slim top bar (brand + daemon status + log out — the
  // things worth seeing at a glance) and a fixed bottom tab bar (icon nav —
  // the thing worth reaching with a thumb). Both are plain siblings of the
  // desktop <aside>, toggled with hidden/md:hidden rather than JS media
  // queries, so there's no layout flash while React hydrates.
  function Sidebar({ view, onNavigate, name, status, reachable, onUpdated, activeUsers }) {
    const state = status?.state ?? "unknown";
    const stateTone = state === "paused" ? "text-amber-400" : state === "idle" ? "text-emerald-400" : "text-slate-400";

    return (
      <>
        <header className="flex flex-col gap-2 border-b border-slate-800 bg-black px-4 py-3 md:hidden">
          <div className="flex items-center justify-between gap-3">
            <h1 className="flex min-w-0 items-center gap-2">
              <Avatar name={name} className="h-7 w-7 text-sm" />
              <span className="truncate text-base font-bold leading-tight text-slate-100">{name}</span>
            </h1>
            <div className="flex flex-none items-center gap-3 text-[11px]">
              <div className="flex items-center gap-1.5">
                <Dot color={reachable ? "bg-emerald-500" : "bg-red-500"} pulse={reachable} />
                <span className={reachable ? stateTone : "text-red-400"}>{reachable ? state : "unreachable"}</span>
              </div>
              <ActiveUsers users={activeUsers} />
              <button type="button" onClick={logout} className="text-slate-600 hover:text-slate-300">
                Log out
              </button>
            </div>
          </div>
          {reachable && <UpdateBanner status={status} onUpdated={onUpdated} />}
        </header>

        <aside className="hidden h-screen w-52 flex-none flex-col border-r border-slate-800 bg-black px-3 py-5 md:flex">
          <div className="mb-6 flex items-center gap-2.5 px-2">
            <Avatar name={name} className="h-7 w-7 text-xs" />
            <span className="truncate text-sm font-medium leading-tight text-slate-100">{name}</span>
          </div>

          <nav className="flex-1 space-y-1">
            {NAV_ITEMS.map((item) => {
              const active = view === item.id;
              const hasWarning = item.warn?.(status);
              return (
                <NavLink
                  key={item.id}
                  href={`/${item.id}`}
                  onClick={() => onNavigate(item.id)}
                  className={`group flex w-full items-center gap-2.5 rounded-sm px-3 py-2 text-sm font-medium transition-colors ${
                    active
                      ? "bg-slate-900 text-slate-100"
                      : "text-slate-500 hover:bg-slate-900/70 hover:text-slate-300"
                  }`}
                >
                  <Icon path={item.icon} className="h-4 w-4 flex-none" />
                  {item.label}
                  {hasWarning && <Dot color="bg-red-500" pulse />}
                </NavLink>
              );
            })}
          </nav>

          <div className="mt-auto space-y-1.5 border-t border-slate-800 px-2 pt-4 text-[11px]">
            <div className="flex items-center gap-2">
              <Dot color={reachable ? "bg-emerald-500" : "bg-red-500"} pulse={reachable} />
              <span className={reachable ? stateTone : "text-red-400"}>
                [daemon] {reachable ? state : "unreachable"}
              </span>
            </div>
            {reachable && status && <p className="text-slate-600">uptime {status.uptimeSec}s</p>}
            {reachable && <ActiveUsers users={activeUsers} />}
            {reachable && <UpdateBanner status={status} onUpdated={onUpdated} />}
            <button type="button" onClick={logout} className="text-slate-600 hover:text-slate-300">
              Log out
            </button>
          </div>
        </aside>

        <nav className="fixed inset-x-0 bottom-0 z-10 flex border-t border-slate-800 bg-black md:hidden">
          {NAV_ITEMS.map((item) => {
            const active = view === item.id;
            const hasWarning = item.warn?.(status);
            return (
              <NavLink
                key={item.id}
                href={`/${item.id}`}
                onClick={() => onNavigate(item.id)}
                className={`flex flex-1 flex-col items-center gap-0.5 py-2.5 text-[10px] font-medium ${
                  active ? "text-brand-400" : "text-slate-500"
                }`}
              >
                <span className="relative">
                  <Icon path={item.icon} className="h-5 w-5" />
                  {hasWarning && (
                    <span className="absolute -right-1 -top-1">
                      <Dot color="bg-red-500" pulse />
                    </span>
                  )}
                </span>
                {item.label}
              </NavLink>
            );
          })}
        </nav>
      </>
    );
  }

  window.ACA.Sidebar = Sidebar;
})();
