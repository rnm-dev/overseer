(function () {
  function Dot({ color, pulse }) {
    return (
      <span className="relative inline-flex h-2.5 w-2.5">
        {pulse && (
          <span className={`absolute inline-flex h-full w-full animate-ping rounded-full ${color} opacity-60`} />
        )}
        <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${color}`} />
      </span>
    );
  }

  function Badge({ children, tone = "slate", title }) {
    const tones = {
      slate: "bg-slate-800 text-slate-300 ring-slate-700",
      green: "bg-emerald-950 text-emerald-400 ring-emerald-800",
      red: "bg-red-950 text-red-400 ring-red-800",
      amber: "bg-amber-950 text-amber-400 ring-amber-800",
    };
    return (
      <span
        title={title}
        className={`inline-flex items-center gap-1.5 rounded-sm px-2 py-1 text-xs font-medium ring-1 ring-inset ${tones[tone]}`}
      >
        {children}
      </span>
    );
  }

  // Standard top-of-page header — the `$ title` treatment lifted from the
  // Sessions page, now shared by every standalone page. `subtitle` and
  // `right` (an action cluster) are optional; `back` renders a ← link above
  // the title for sub-pages.
  function PageHeader({ title, subtitle, right, back }) {
    return (
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          {back}
          <h1 className="text-lg font-medium text-slate-100">
            {title}
          </h1>
          {subtitle && <p className="text-sm text-slate-500">{subtitle}</p>}
        </div>
        {right && <div className="flex flex-none flex-wrap items-center gap-2">{right}</div>}
      </div>
    );
  }

  // Standard bordered, divided list container — the Sessions list look, now
  // shared by every standalone page's list. Rows are caller-supplied <li>
  // children; give them `px-4 py-3` padding to sit inside the border.
  function List({ children }) {
    return (
      <ul className="divide-y divide-slate-800 rounded-sm border border-slate-800 bg-slate-900/40">{children}</ul>
    );
  }

  // Bordered content box for a page's non-list content (forms, detail
  // panels) — same framing as List/the New-session form, so a PageHeader
  // page reads as one system whether its body is a list or a form.
  function Panel({ children, className = "" }) {
    return <div className={`rounded-sm border border-slate-800 bg-slate-900/40 p-4 ${className}`}>{children}</div>;
  }

  function Card({ title, right, children }) {
    return (
      <div className="overflow-hidden rounded-sm border border-slate-800 bg-slate-900/40">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-4 py-2.5">
          <h2 className="min-w-0 truncate text-base font-medium text-slate-100">{title}</h2>
          {right}
        </div>
        <div className="p-4">{children}</div>
      </div>
    );
  }

  // Shared by Button (below) and NavLink: lets a plain left-click do fast
  // client-side nav via onClick, while middle-click/Cmd/Ctrl-click fall
  // through to the browser's native new-tab handling on the real href.
  function handleNavClick(e, disabled, onClick) {
    if (disabled) {
      e.preventDefault();
      return;
    }
    if (!window.ACA.isPlainLeftClick(e)) return;
    e.preventDefault();
    onClick?.();
  }

  // Renders as a real <a href> when `href` is given (so middle-click/new-tab
  // works), or a plain <button> otherwise — same look either way.
  function Button({ children, onClick, href, disabled, title, variant = "primary", type = "button" }) {
    const variants = {
      primary: "border border-slate-300 bg-slate-100 text-slate-950 hover:bg-white disabled:border-slate-700 disabled:bg-slate-700",
      ghost: "bg-slate-800 hover:bg-slate-700 text-slate-200 disabled:text-slate-500",
      danger: "bg-red-900/60 hover:bg-red-900 text-red-200 disabled:text-slate-500",
    };
    const className = `rounded-sm px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${variants[variant]}`;
    if (href) {
      return (
        <a
          href={disabled ? undefined : href}
          aria-disabled={disabled}
          title={title}
          onClick={(e) => handleNavClick(e, disabled, onClick)}
          className={className}
        >
          {children}
        </a>
      );
    }
    return (
      <button type={type} onClick={onClick} disabled={disabled} title={title} className={className}>
        {children}
      </button>
    );
  }

  // Bare navigational anchor for row-links/back-links that don't use
  // Button's styling — caller supplies className to match the old
  // <button className="...">.
  function NavLink({ href, onClick, disabled, className, children }) {
    return (
      <a
        href={disabled ? undefined : href}
        aria-disabled={disabled}
        onClick={(e) => handleNavClick(e, disabled, onClick)}
        className={className}
      >
        {children}
      </a>
    );
  }

  // Underline-style tab bar for in-page subnav (e.g. Settings' General/AI/
  // Armory). Each tab renders as a real <a href> via NavLink so
  // middle-click/new-tab keeps working; `onSelect` handles the plain
  // left-click for fast client-side nav. Pass `warn: true` on a tab to
  // surface a pulsing red dot (same signal as the sidebar's own warnings).
  function Tabs({ tabs, active, onSelect }) {
    return (
      <div className="flex flex-wrap gap-1 border-b border-slate-800">
        {tabs.map((tab) => {
          const isActive = tab.id === active;
          return (
            <NavLink
              key={tab.id}
              href={tab.href}
              onClick={() => onSelect(tab.id)}
              className={`relative -mb-px flex items-center gap-1.5 border-b px-3 py-2 text-sm font-medium transition-colors ${
                isActive
                  ? "border-brand-500 text-brand-300"
                  : "border-transparent text-slate-400 hover:border-slate-700 hover:text-slate-200"
              }`}
            >
              {tab.label}
              {tab.warn && <Dot color="bg-red-500" pulse />}
            </NavLink>
          );
        })}
      </div>
    );
  }

  function Toggle({ pressed, onToggle, onLabel = "Plan", offLabel = "Default", title }) {
    return (
      <button
        type="button"
        title={title}
        onClick={onToggle}
        aria-pressed={pressed}
        className={`inline-flex items-center gap-1.5 rounded-sm px-2 py-1 text-xs font-medium ring-1 ring-inset transition-colors ${
          pressed
            ? "bg-amber-950 text-amber-400 ring-amber-800"
            : "bg-slate-800 text-slate-400 ring-slate-700 hover:text-slate-200"
        }`}
      >
        {pressed ? onLabel : offLabel}
      </button>
    );
  }

  function ProgressBar({ value }) {
    return (
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
        <div
          className="h-full rounded-full bg-brand-500 transition-all"
          style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
        />
      </div>
    );
  }

  // No image is stored per instance, so the avatar is a generated monogram:
  // the name's first letter over the brand gradient. `unnamed`/missing names
  // still yield a stable "?"/"U" tile rather than an empty circle. Shared so
  // the sidebar identity and the chat's bot bubble render the same face.
  function Avatar({ name, className }) {
    const initial = (name?.trim()?.[0] ?? "?").toUpperCase();
    return (
      <span
        className={`flex flex-none items-center justify-center rounded-sm border border-slate-700 bg-slate-800 font-medium text-slate-200 ${className}`}
      >
        {initial}
      </span>
    );
  }

  // The main content area that sits to the right of the sidebar on every
  // page — the shared width/scroll/padding treatment used to be duplicated
  // inline in app.jsx; pulled out here so every page renders through the
  // same wrapper.
  function ContentWrapper({ children }) {
    return (
      <main className="min-w-0 flex-1 overflow-y-auto px-3 py-4 pb-20 sm:px-4 md:px-4 md:py-5 md:pb-5">
        <div className="w-full">{children}</div>
      </main>
    );
  }

  Object.assign(window.ACA, { Dot, Badge, Card, PageHeader, List, Panel, Button, NavLink, Tabs, Toggle, ProgressBar, Avatar, ContentWrapper });
})();
