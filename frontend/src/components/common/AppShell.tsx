import { useSetupStatus } from "~/api/hooks";
import { CommandPalette } from "~/components/common/CommandPalette";
import { SetupWizard } from "~/components/setup/SetupWizard";
import { StatusFooter } from "~/components/shell/StatusFooter";
import { TopBar } from "~/components/shell/TopBar";

export function AppShell({ children }: { children: React.ReactNode }) {
  const status = useSetupStatus();

  if (status.isPending) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-fg-faint">
        Connecting…
      </div>
    );
  }
  if (status.error) {
    return (
      <div className="flex h-screen items-center justify-center p-6 text-sm text-danger">
        Failed to reach backend: {status.error.message}
      </div>
    );
  }
  if (status.data?.needs_setup) {
    return <SetupWizard />;
  }
  return (
    <div className="flex h-screen flex-col">
      <TopBar />
      <div className="flex flex-1 overflow-hidden">{children}</div>
      <StatusFooter />
      <CommandPalette />
    </div>
  );
}
