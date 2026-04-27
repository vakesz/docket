"use client";

import { useState } from "react";
import {
  fieldClass,
  primaryButtonClass,
  settingsRowClass,
  xsBorderButtonClass,
  xsDangerButtonClass,
} from "@/lib/form-classes";
import { trpc } from "@/lib/trpc-client";

type Props = {
  projectId: string;
};

const ROLES = ["viewer", "member", "approver"] as const;
type Role = (typeof ROLES)[number];

/**
 * Project members panel. Approver-only mutations; everyone can read
 * the roster. Owner row sits up top, immutable. Adding by email looks
 * the user up — they have to have signed in at least once.
 */
export function MembersPanel({ projectId }: Props) {
  const utils = trpc.useUtils();
  const list = trpc.projects.members.useQuery({ projectId });

  const add = trpc.projects.addMember.useMutation({
    onSuccess: async () => {
      setEmail("");
      setRole("member");
      await utils.projects.members.invalidate({ projectId });
    },
  });
  const updateRole = trpc.projects.updateMemberRole.useMutation({
    onSuccess: async () => utils.projects.members.invalidate({ projectId }),
  });
  const remove = trpc.projects.removeMember.useMutation({
    onSuccess: async () => utils.projects.members.invalidate({ projectId }),
  });

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");

  const callerIsOwner = list.data?.callerIsOwner ?? false;
  const canManage = callerIsOwner;

  const onAdd = () => {
    if (!email.trim()) return;
    add.mutate({ projectId, email: email.trim(), role });
  };

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-fg">Add member</h3>
        <p className="text-xs text-fg-muted">
          Invite by email. The user must have signed in at least once. Roles:{" "}
          <span className="font-mono">viewer</span> can read,{" "}
          <span className="font-mono">member</span> can stage proposals,{" "}
          <span className="font-mono">approver</span> can confirm them and manage members.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="email"
            placeholder="someone@example.com"
            value={email}
            disabled={!canManage || add.isPending}
            onChange={(e) => setEmail(e.target.value)}
            className={`${fieldClass} max-w-[20rem]`}
          />
          <select
            value={role}
            disabled={!canManage || add.isPending}
            onChange={(e) => setRole(e.target.value as Role)}
            className={`${fieldClass} max-w-[10rem]`}
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={onAdd}
            disabled={!canManage || add.isPending || !email.trim()}
            className={primaryButtonClass}
          >
            {add.isPending ? "Adding…" : "Add"}
          </button>
        </div>
        {!canManage ? (
          <p className="text-xs text-fg-faint">Only the project owner can change membership.</p>
        ) : null}
        {add.error ? <p className="text-xs text-danger-fg">{add.error.message}</p> : null}
      </section>

      <section className={settingsRowClass}>
        <h3 className="text-sm font-medium text-fg">Members</h3>
        {list.isPending ? (
          <p className="text-xs text-fg-faint">Loading…</p>
        ) : list.error ? (
          <p className="text-xs text-danger-fg">{list.error.message}</p>
        ) : list.data ? (
          <ul className="flex flex-col divide-y divide-border rounded-2xl border border-border bg-surface">
            <MemberRow
              name={list.data.owner.name ?? ""}
              email={list.data.owner.email ?? ""}
              image={list.data.owner.image}
              roleBadge="owner"
            />
            {list.data.members.length === 0 ? (
              <li className="px-4 py-3 text-xs text-fg-faint">
                No additional members. Invite a teammate above.
              </li>
            ) : (
              list.data.members.map((m) => (
                <MemberRow
                  key={m.membershipId}
                  name={m.name ?? ""}
                  email={m.email ?? ""}
                  image={m.image}
                  roleBadge={m.role}
                  controls={
                    canManage ? (
                      <div className="flex items-center gap-2">
                        <select
                          value={m.role}
                          disabled={updateRole.isPending}
                          onChange={(e) =>
                            updateRole.mutate({
                              projectId,
                              membershipId: m.membershipId,
                              role: e.target.value as Role,
                            })
                          }
                          className={`${fieldClass} h-8 max-w-[8rem] py-1 text-xs`}
                        >
                          {ROLES.map((r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={() => {
                            if (!confirm(`Remove ${m.email ?? m.name ?? "this member"}?`)) return;
                            remove.mutate({ projectId, membershipId: m.membershipId });
                          }}
                          disabled={remove.isPending}
                          className={xsDangerButtonClass}
                        >
                          Remove
                        </button>
                      </div>
                    ) : (
                      <span className={xsBorderButtonClass}>{m.role}</span>
                    )
                  }
                />
              ))
            )}
          </ul>
        ) : null}
        {updateRole.error ? (
          <p className="text-xs text-danger-fg">{updateRole.error.message}</p>
        ) : null}
        {remove.error ? <p className="text-xs text-danger-fg">{remove.error.message}</p> : null}
      </section>
    </div>
  );
}

function MemberRow({
  name,
  email,
  image,
  roleBadge,
  controls,
}: {
  name: string;
  email: string;
  image: string | null;
  roleBadge: string;
  controls?: React.ReactNode;
}) {
  return (
    <li className="flex items-center justify-between gap-3 px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <Avatar name={name || email} image={image} />
        <div className="min-w-0">
          <div className="truncate text-sm text-fg">{name || email || "—"}</div>
          {name && email ? <div className="truncate text-xs text-fg-muted">{email}</div> : null}
        </div>
      </div>
      <div className="flex items-center gap-3">
        {controls ?? (
          <span className="rounded-full border border-border bg-surface-alt px-2 py-0.5 text-[10px] uppercase tracking-wide text-fg-muted">
            {roleBadge}
          </span>
        )}
      </div>
    </li>
  );
}

function Avatar({ name, image }: { name: string; image: string | null }) {
  if (image) {
    // Use a CSS background so we don't trigger Next's <Image> remote-allowlist
    // requirement for arbitrary OAuth-provided avatar URLs.
    return (
      <div
        aria-hidden="true"
        className="h-8 w-8 shrink-0 rounded-full border border-border bg-surface-alt bg-cover bg-center"
        style={{ backgroundImage: `url(${JSON.stringify(image)})` }}
      />
    );
  }
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase())
    .join("");
  return (
    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-surface-alt font-mono text-[11px] text-fg-muted">
      {initials || "?"}
    </div>
  );
}
