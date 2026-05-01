"use client";

import { avatarUrl } from "@/lib/avatar-url";

export function CommentAvatar({
  name,
  providerKind,
  providerHasAvatars,
}: {
  name: string;
  providerKind: string | null;
  providerHasAvatars: boolean;
}) {
  const url = providerKind && providerHasAvatars ? avatarUrl(providerKind, name) : null;
  const initial = name.charAt(0).toUpperCase() || "?";
  return (
    <span
      aria-hidden="true"
      className="relative flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-background/40 font-medium font-sans text-muted-foreground/70 text-xs"
    >
      <span>{initial}</span>
      {url ? (
        // biome-ignore lint/performance/noImgElement: same-origin avatar route already streams cached bytes; next/image would add a layout layer for no benefit at this size.
        <img
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          className="absolute inset-0 size-full object-cover"
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = "none";
          }}
        />
      ) : null}
    </span>
  );
}
