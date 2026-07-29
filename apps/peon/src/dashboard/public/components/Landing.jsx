(function () {
  const { useState } = React;

  const INSTALL_COMMAND = "npm install -g git+ssh://git@github.com/rnm-dev/peon.git";

  function Landing() {
    const [copied, setCopied] = useState(false);

    const copyInstall = async () => {
      try {
        await navigator.clipboard.writeText(INSTALL_COMMAND);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1800);
      } catch {
        // The command remains selectable when clipboard access is unavailable.
      }
    };

    return (
      <main className="min-h-screen bg-black text-slate-200">
        <nav className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
          <a href="/" className="text-sm font-medium text-slate-100">peon</a>
          <div className="flex items-center gap-4 text-xs">
            <a className="text-slate-500 hover:text-slate-200" href="https://github.com/rnm-dev/peon">GitHub</a>
            <a className="rounded-sm border border-slate-700 px-3 py-1.5 text-slate-200 hover:border-slate-500" href="/home">Dashboard</a>
          </div>
        </nav>

        <section className="grid min-h-[calc(100vh-49px)] items-center gap-8 px-4 py-10 md:grid-cols-2 md:px-8">
          <div>
            <p className="mb-3 text-xs text-slate-500">Autonomous coding agent daemon</p>
            <h1 className="max-w-2xl text-3xl font-medium leading-tight text-slate-100 sm:text-5xl">Keep the backlog moving.</h1>
            <p className="mt-4 max-w-xl text-sm leading-6 text-slate-500">
              Peon runs coding agents, verifies their work, and keeps every session visible from one dashboard.
            </p>
            <div className="mt-6 flex gap-2">
              <a href="/home" className="rounded-sm bg-slate-100 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-white">Open dashboard</a>
              <a href="#install" className="rounded-sm border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:border-slate-500">Install</a>
            </div>
          </div>

          <div id="install" className="border border-slate-800 bg-slate-950 p-4">
            <div className="mb-3 flex items-center justify-between text-xs text-slate-500">
              <span>Install</span>
              <button type="button" onClick={copyInstall} className="hover:text-slate-200">{copied ? "Copied" : "Copy"}</button>
            </div>
            <code className="block overflow-x-auto border-t border-slate-800 pt-3 text-xs text-slate-300">$ {INSTALL_COMMAND}</code>
          </div>
        </section>
      </main>
    );
  }

  window.ACA.Landing = Landing;
})();
