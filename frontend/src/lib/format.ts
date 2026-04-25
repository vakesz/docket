export function formatRelative(isoOrNull: string | null | undefined): string {
  if (!isoOrNull) return "—";
  const then = new Date(isoOrNull).getTime();
  if (Number.isNaN(then)) return "—";
  const diff = Date.now() - then;
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(isoOrNull).toISOString().slice(0, 10);
}

const STATE_LABELS: Record<string, string> = {
  new: "New",
  active: "Active",
  blocked: "Blocked",
  needs_info: "Needs info",
  resolved: "Resolved",
  closed: "Closed",
};

export function formatState(state: string): string {
  return STATE_LABELS[state] ?? state;
}

const KIND_LABELS: Record<string, string> = {
  epic: "Epic",
  feature: "Feature",
  story: "Story",
  task: "Task",
  bug: "Bug",
};

export function formatKind(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

const INTENT_LABELS: Record<string, string> = {
  start_work: "Start work",
  pause: "Pause",
  block: "Block",
  needs_info: "Needs info",
  close_done: "Close (done)",
  close_wontfix: "Close (won't fix)",
  reopen: "Reopen",
};

export function formatIntent(intent: string): string {
  return INTENT_LABELS[intent] ?? intent;
}

// GitHub-style labels often embed emoji shortcodes like ":chart_with_upwards_trend:"
// inside the label name, which renders as noisy literal text. Strip them for
// display only — the raw tag string stays authoritative for filtering.
export function displayTag(raw: string): string {
  return (
    raw
      .replace(/:[a-z0-9_+-]+:/gi, "")
      .replace(/\s+/g, " ")
      .trim() || raw
  );
}
