import { markdown } from "@codemirror/lang-markdown";
import { createFileRoute } from "@tanstack/react-router";
import CodeMirror from "@uiw/react-codemirror";
import { useEffect, useState } from "react";

import { usePrompt, usePrompts, usePutPrompt, useResetPrompt } from "~/api/hooks";
import { cn } from "~/lib/cn";

export const Route = createFileRoute("/prompts")({
  component: PromptsPage,
});

function PromptsPage() {
  const prompts = usePrompts();
  const [selected, setSelected] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!selected && prompts.data?.[0]) setSelected(prompts.data[0].key);
  }, [prompts.data, selected]);

  return (
    <div className="flex h-full">
      <aside className="w-64 border-r border-zinc-200 bg-zinc-50 p-2 dark:border-zinc-800 dark:bg-zinc-900/50">
        {prompts.isPending && <div className="p-2 text-xs text-zinc-500">Loading…</div>}
        <ul className="flex flex-col gap-0.5">
          {prompts.data?.map((p) => (
            <li key={p.key}>
              <button
                type="button"
                onClick={() => setSelected(p.key)}
                className={cn(
                  "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm",
                  selected === p.key
                    ? "bg-zinc-200 dark:bg-zinc-800"
                    : "hover:bg-zinc-100 dark:hover:bg-zinc-900",
                )}
              >
                <span>{p.label}</span>
                {p.customized && (
                  <span className="ml-auto font-mono text-[10px] text-accent">edited</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <section className="flex flex-1 flex-col overflow-auto">
        {selected ? <PromptEditor key={selected} promptKey={selected} /> : null}
      </section>
    </div>
  );
}

function PromptEditor({ promptKey }: { promptKey: string }) {
  const prompt = usePrompt(promptKey);
  const put = usePutPrompt();
  const reset = useResetPrompt();
  const [draft, setDraft] = useState<string>("");

  useEffect(() => {
    if (prompt.data) setDraft(prompt.data.content_md);
  }, [prompt.data]);

  if (prompt.isPending) {
    return <div className="p-6 text-sm text-zinc-500">Loading…</div>;
  }
  if (!prompt.data) return null;

  const dirty = draft !== prompt.data.content_md;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <div>
          <h1 className="text-sm font-semibold">{prompt.data.label}</h1>
          <div className="font-mono text-[10px] text-zinc-500">{prompt.data.filename}</div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            disabled={reset.isPending}
            onClick={() => reset.mutate(promptKey)}
            className="rounded border border-zinc-200 px-3 py-1 text-xs hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
          >
            Reset to default
          </button>
          <button
            type="button"
            disabled={!dirty || put.isPending}
            onClick={() => put.mutate({ key: promptKey, contentMd: draft })}
            className="rounded bg-accent px-3 py-1 text-xs font-semibold text-white hover:bg-accent/90 disabled:opacity-50"
          >
            {put.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </header>
      <div className="flex-1 overflow-hidden">
        <CodeMirror
          value={draft}
          height="100%"
          theme="dark"
          extensions={[markdown()]}
          onChange={setDraft}
          basicSetup={{ lineNumbers: true, foldGutter: true }}
          className="h-full"
        />
      </div>
    </div>
  );
}
