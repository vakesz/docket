"use client";

import { useId, useState } from "react";
import { trpc } from "@/lib/trpc-client";
import { Alert, AlertDescription } from "@/ui/primitives/alert";
import { Badge } from "@/ui/primitives/badge";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/primitives/select";

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
  const emailId = useId();
  const roleId = useId();

  const callerIsOwner = list.data?.callerIsOwner ?? false;
  const canManage = callerIsOwner;

  const onAdd = () => {
    if (!email.trim()) return;
    add.mutate({ projectId, email: email.trim(), role });
  };

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-foreground">Add member</h3>
        <p className="text-xs text-muted-foreground">
          Invite by email. The user must have signed in at least once. Roles:{" "}
          <span className="font-mono">viewer</span> can read,{" "}
          <span className="font-mono">member</span> can stage proposals,{" "}
          <span className="font-mono">approver</span> can confirm them and manage members.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id={emailId}
            type="email"
            placeholder="someone@example.com"
            value={email}
            disabled={!canManage || add.isPending}
            onChange={(e) => setEmail(e.target.value)}
            aria-label="Member email address"
            className="max-w-[20rem]"
          />
          <Select
            value={role}
            disabled={!canManage || add.isPending}
            onValueChange={(value) => setRole(value as Role)}
          >
            <SelectTrigger id={roleId} aria-label="Member role" className="max-w-[10rem]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ROLES.map((r) => (
                <SelectItem key={r} value={r}>
                  {r}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            onClick={onAdd}
            disabled={!canManage || add.isPending || !email.trim()}
          >
            {add.isPending ? "Adding…" : "Add"}
          </Button>
        </div>
        {!canManage ? (
          <p className="text-xs text-muted-foreground-faint">
            Only the project owner can change membership.
          </p>
        ) : null}
        {add.error ? (
          <Alert variant="destructive">
            <AlertDescription>{add.error.message}</AlertDescription>
          </Alert>
        ) : null}
      </section>

      <section className="flex flex-col gap-2 border-t border-border first:border-t-0 first:pt-0 pt-4">
        <h3 className="text-sm font-medium text-foreground">Members</h3>
        {list.isPending ? (
          <p className="text-xs text-muted-foreground-faint">Loading…</p>
        ) : list.error ? (
          <Alert variant="destructive">
            <AlertDescription>{list.error.message}</AlertDescription>
          </Alert>
        ) : list.data ? (
          <ul className="flex flex-col divide-y divide-border rounded-2xl border border-border bg-card">
            <MemberRow
              name={list.data.owner.name ?? ""}
              email={list.data.owner.email ?? ""}
              image={list.data.owner.image}
              roleBadge="owner"
            />
            {list.data.members.length === 0 ? (
              <li className="px-4 py-3 text-xs text-muted-foreground-faint">
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
                        <Select
                          value={m.role}
                          disabled={updateRole.isPending}
                          onValueChange={(value) =>
                            updateRole.mutate({
                              projectId,
                              membershipId: m.membershipId,
                              role: value as Role,
                            })
                          }
                        >
                          <SelectTrigger
                            aria-label={`Role for ${m.email ?? m.name ?? "member"}`}
                            className="h-7 max-w-[8rem] text-xs"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {ROLES.map((r) => (
                              <SelectItem key={r} value={r}>
                                {r}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Button
                          type="button"
                          variant="destructive"
                          size="xs"
                          onClick={() => {
                            if (!confirm(`Remove ${m.email ?? m.name ?? "this member"}?`)) return;
                            remove.mutate({ projectId, membershipId: m.membershipId });
                          }}
                          disabled={remove.isPending}
                        >
                          Remove
                        </Button>
                      </div>
                    ) : (
                      <Badge variant="outline" className="uppercase tracking-wide">
                        {m.role}
                      </Badge>
                    )
                  }
                />
              ))
            )}
          </ul>
        ) : null}
        {updateRole.error ? (
          <Alert variant="destructive">
            <AlertDescription>{updateRole.error.message}</AlertDescription>
          </Alert>
        ) : null}
        {remove.error ? (
          <Alert variant="destructive">
            <AlertDescription>{remove.error.message}</AlertDescription>
          </Alert>
        ) : null}
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
          <div className="truncate text-sm text-foreground">{name || email || "—"}</div>
          {name && email ? (
            <div className="truncate text-xs text-muted-foreground">{email}</div>
          ) : null}
        </div>
      </div>
      <div className="flex items-center gap-3">
        {controls ?? (
          <Badge variant="outline" className="uppercase tracking-wide">
            {roleBadge}
          </Badge>
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
        className="h-8 w-8 shrink-0 rounded-full border border-border bg-muted bg-cover bg-center"
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
    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-muted font-mono text-[11px] text-muted-foreground">
      {initials || "?"}
    </div>
  );
}
