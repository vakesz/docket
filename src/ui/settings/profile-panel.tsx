"use client";
import { trpc } from "@/lib/trpc-client";
import { DefaultProjectPicker } from "@/ui/settings/default-project-picker";

/**
 * Profile section — per-user preferences. Default-project picker plus the
 * chat.send-on-enter toggle (the only entry currently in the user-scoped
 * settings catalog). Theme stays in the top bar because it's browser-local.
 */
export function ProfilePanel() {
  const utils = trpc.useUtils();
  const list = trpc.settings.list.useQuery();
  const update = trpc.settings.update.useMutation({
    onSuccess: async () => {
      await utils.settings.list.invalidate();
    },
  });

  const sendOnEnter = list.data?.find((r) => r.key === "chat.send-on-enter")?.value ?? true;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h2 className="text-base font-medium text-fg">Profile</h2>
        <p className="text-sm text-fg-muted">
          Per-user preferences. Theme lives in the top bar — it&rsquo;s browser-local.
        </p>
      </header>

      <DefaultProjectPicker />

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium text-fg">Chat — send on Enter</span>
        <p className="text-xs text-fg-muted">
          When on, Enter sends a message and Shift+Enter inserts a newline. When off, Enter inserts
          a newline and Cmd/Ctrl+Enter sends.
        </p>
        <label className="inline-flex items-center gap-2 text-sm text-fg">
          <input
            type="checkbox"
            checked={sendOnEnter === true}
            disabled={update.isPending || list.isPending}
            onChange={(e) =>
              update.mutate({
                key: "chat.send-on-enter" as never,
                value: e.target.checked,
              })
            }
          />
          <span>Enabled</span>
        </label>
        {update.error ? <p className="text-xs text-danger-fg">{update.error.message}</p> : null}
      </div>
    </div>
  );
}
