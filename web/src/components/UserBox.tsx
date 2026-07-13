import { useAuth } from "../auth";
import { Button, LocaleSwitcher } from "../ui";
import { useT } from "../i18n";

// author: Viktor
// Floating account panel — pinned bottom-left on the fleet dashboard and used
// as the footer of the peon sidebar on desktop.
export function UserBox({ hideOnMobile = false }: { hideOnMobile?: boolean }) {
  const { user, logout } = useAuth();
  const t = useT();

  return (
    <div
      className={`user-box fixed bottom-3 left-3 z-40 w-52 space-y-2 rounded-lg border border-iron-800 bg-iron-950/85 px-3 py-2.5 shadow-lg backdrop-blur ${
        hideOnMobile ? "hidden md:block" : ""
      }`}
    >
      <div className="truncate px-0.5 font-mono text-[0.7rem] text-bone-dim" title={user?.email}>
        {user?.email}
      </div>
      <div className="flex items-center justify-between gap-2">
        <LocaleSwitcher />
        <Button variant="iron" size="sm" onClick={() => logout()}>
          {t("action.signOut")}
        </Button>
      </div>
    </div>
  );
}
