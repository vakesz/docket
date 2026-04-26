/**
 * Single chat message row. Tone + label keyed off `messageRole` so the
 * same component renders user / assistant / system / tool turns.
 */
export function MessageBubble({ messageRole, content }: { messageRole: string; content: string }) {
  const tone =
    messageRole === "user"
      ? "self-end bg-primary/10 text-primary-foreground"
      : messageRole === "assistant"
        ? "self-start bg-muted"
        : "self-stretch border border-dashed border-border bg-muted/40 text-muted-foreground";
  const label =
    messageRole === "user"
      ? "You"
      : messageRole === "assistant"
        ? "Assistant"
        : messageRole === "system"
          ? "System"
          : messageRole;
  return (
    <div className={`max-w-[85%] rounded-md px-3 py-2 text-sm ${tone}`}>
      <div className="mb-1 text-[10px] uppercase tracking-wide opacity-70">{label}</div>
      <div className="whitespace-pre-wrap break-words text-sm text-foreground">{content}</div>
    </div>
  );
}
