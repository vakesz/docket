import { markdown } from "@codemirror/lang-markdown";
import { EditorView } from "@codemirror/view";
import CodeMirror from "@uiw/react-codemirror";
import { FilePlus2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { DTO } from "~/api/client";
import {
  useConfirmItemCreate,
  useProviders,
  useRejectItemCreate,
  useSearchItems,
  useStageItemCreate,
  useStatus,
} from "~/api/hooks";
import { Label } from "~/components/common/Label";
import { Modal } from "~/components/common/Modal";
import { Notice } from "~/components/common/Notice";
import {
  buildCreateRequest,
  pickInitialKind,
  resolveSupportedKinds,
} from "~/components/items/newItemForm";
import { docketCodeMirrorTheme } from "~/lib/cmTheme";
import { formatKind, formatState } from "~/lib/format";

type ItemKind = DTO["ItemKind"];

interface Props {
  defaultKind: ItemKind;
  onClose: () => void;
  onCreated: (itemId: string) => void;
}

export function NewItemModal({ defaultKind, onClose, onCreated }: Props) {
  const stageMutation = useStageItemCreate();
  const confirmMutation = useConfirmItemCreate();
  const rejectMutation = useRejectItemCreate();
  const providers = useProviders();
  const status = useStatus();
  const readOnly = status.data?.read_only ?? false;
  const pending = stageMutation.isPending || confirmMutation.isPending;
  const mutationError = stageMutation.error ?? confirmMutation.error;

  const supportedKinds = useMemo<ItemKind[]>(
    () => resolveSupportedKinds(providers.data?.find((p) => p.active)?.supported_kinds),
    [providers.data],
  );

  const initialKind = pickInitialKind(supportedKinds, defaultKind);

  const titleRef = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<ItemKind>(initialKind);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [parentId, setParentId] = useState("");
  const [assignee, setAssignee] = useState("");
  const [tagsRaw, setTagsRaw] = useState("");
  const [proposal, setProposal] = useState<DTO["ProposalDTO"] | null>(null);

  // Re-seed the kind select once the providers query resolves and the active
  // provider's supported_kinds lands. Without this, the picker stays on the
  // initial fallback if the user-configured default isn't in the supported set.
  useEffect(() => {
    if (!supportedKinds.includes(kind)) setKind(supportedKinds[0] ?? "task");
  }, [supportedKinds, kind]);

  // Autofocus the title when the modal mounts. Using a ref + useEffect keeps
  // biome's a11y rule happy while preserving the feel of `autoFocus`.
  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  // Debounce the title for the duplicate search.
  const [debouncedTitle, setDebouncedTitle] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedTitle(title.trim()), 250);
    return () => clearTimeout(t);
  }, [title]);
  const duplicates = useSearchItems(debouncedTitle, { kind, limit: 5 });

  const canStage = !readOnly && title.trim().length > 0 && !pending && proposal === null;
  const canCreate = !readOnly && proposal !== null && !pending;

  const buildRequest = useCallback(
    () => buildCreateRequest({ kind, title, description, parentId, assignee, tagsRaw }),
    [assignee, description, kind, parentId, tagsRaw, title],
  );

  const stage = useCallback(async () => {
    if (!canStage) return;
    const result = await stageMutation.mutateAsync(buildRequest());
    setProposal(result);
  }, [buildRequest, canStage, stageMutation]);

  const confirm = useCallback(async () => {
    if (!canCreate || proposal === null) return;
    const result = await confirmMutation.mutateAsync(proposal.id);
    if (result.item) {
      onCreated(result.item.id);
    } else {
      onClose();
    }
  }, [canCreate, confirmMutation, onClose, onCreated, proposal]);

  const backToEdit = () => {
    if (proposal !== null) {
      // Fire-and-forget — the proposal is server-side state; if reject fails
      // the store just holds an orphan until the process recycles.
      void rejectMutation.mutateAsync(proposal.id).catch(() => undefined);
    }
    setProposal(null);
    stageMutation.reset();
    confirmMutation.reset();
  };

  const onFormKeyDown = (e: React.KeyboardEvent<HTMLFormElement>) => {
    // Ctrl/Cmd+S from any field in edit phase stages the proposal.
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s" && proposal === null) {
      e.preventDefault();
      void stage();
    }
  };

  return (
    <Modal onClose={onClose} className="max-w-3xl">
      <header className="flex items-center gap-3 border-b border-border px-6 py-4">
        <div className="rounded-xl bg-accent/10 p-2 text-accent">
          <FilePlus2 className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold text-fg">
            {proposal ? "Review proposal" : "New work item"}
          </h2>
          <p className="truncate text-xs text-fg-muted">
            {proposal
              ? "Confirm to create. The proposal is not staged until you click Create item."
              : "Draft a ticket. A proposal with a diff will be shown before anything is written."}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-xl p-1.5 text-fg-muted hover:bg-surface-alt"
          title="Close (Esc)"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      <form
        onSubmit={(e) => e.preventDefault()}
        onKeyDown={onFormKeyDown}
        className="flex min-h-0 flex-1 flex-col overflow-auto px-6 py-5"
      >
        {readOnly && (
          <Notice tone="warning" title="Read-only mode" className="mb-4">
            Mutations are disabled. Disable read-only mode to create items.
          </Notice>
        )}
        {mutationError && (
          <Notice tone="error" title="Create failed" className="mb-4">
            {mutationError.message}
          </Notice>
        )}

        {proposal ? (
          <pre className="whitespace-pre-wrap rounded-xl border border-border bg-bg p-4 font-mono text-xs text-fg">
            {proposal.diff}
          </pre>
        ) : (
          <EditPhase
            kind={kind}
            kinds={supportedKinds}
            title={title}
            description={description}
            parentId={parentId}
            assignee={assignee}
            tagsRaw={tagsRaw}
            duplicates={duplicates.data}
            duplicatesLoading={duplicates.isFetching}
            titleRef={titleRef}
            onKind={setKind}
            onTitle={setTitle}
            onDescription={setDescription}
            onParent={setParentId}
            onAssignee={setAssignee}
            onTags={setTagsRaw}
          />
        )}
      </form>

      <footer className="flex items-center justify-end gap-2 border-t border-border bg-surface/70 px-6 py-3">
        {proposal ? (
          <>
            <button
              type="button"
              onClick={backToEdit}
              className="rounded-xl border border-border px-3 py-2 text-sm font-medium text-fg hover:bg-bg"
            >
              Back to edit
            </button>
            <button
              type="button"
              onClick={() => void confirm()}
              disabled={!canCreate}
              className="inline-flex items-center gap-2 rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-accent-fg hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {confirmMutation.isPending ? "Creating…" : "Create item"}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-border px-3 py-2 text-sm font-medium text-fg hover:bg-bg"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void stage()}
              disabled={!canStage}
              title="Ctrl/Cmd+S"
              className="inline-flex items-center gap-2 rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-accent-fg hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {stageMutation.isPending ? "Staging…" : "Stage proposal"}
            </button>
          </>
        )}
      </footer>
    </Modal>
  );
}

function EditPhase({
  kind,
  kinds,
  title,
  description,
  parentId,
  assignee,
  tagsRaw,
  duplicates,
  duplicatesLoading,
  titleRef,
  onKind,
  onTitle,
  onDescription,
  onParent,
  onAssignee,
  onTags,
}: {
  kind: ItemKind;
  kinds: ItemKind[];
  title: string;
  description: string;
  parentId: string;
  assignee: string;
  tagsRaw: string;
  duplicates: DTO["ItemDTO"][] | undefined;
  duplicatesLoading: boolean;
  titleRef: React.RefObject<HTMLInputElement | null>;
  onKind: (v: ItemKind) => void;
  onTitle: (v: string) => void;
  onDescription: (v: string) => void;
  onParent: (v: string) => void;
  onAssignee: (v: string) => void;
  onTags: (v: string) => void;
}) {
  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-4 sm:grid-cols-[160px_1fr]">
        <div>
          <Label>Kind</Label>
          <select
            value={kind}
            onChange={(e) => onKind(e.target.value as ItemKind)}
            className="mt-2 w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none"
          >
            {kinds.map((k) => (
              <option key={k} value={k}>
                {formatKind(k)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label>Title</Label>
          <input
            ref={titleRef}
            value={title}
            onChange={(e) => onTitle(e.target.value)}
            placeholder="Short, specific title"
            className="mt-2 w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none"
          />
        </div>
      </div>

      {title.trim().length >= 3 && (
        <DuplicatesPanel loading={duplicatesLoading} duplicates={duplicates ?? []} />
      )}

      <div>
        <Label>Description (markdown)</Label>
        <div className="mt-2 overflow-hidden rounded-xl border border-border">
          <CodeMirror
            value={description}
            height="200px"
            theme="none"
            extensions={[markdown(), EditorView.lineWrapping, ...docketCodeMirrorTheme()]}
            onChange={onDescription}
            basicSetup={{
              lineNumbers: false,
              foldGutter: false,
              highlightActiveLine: false,
              highlightActiveLineGutter: false,
            }}
            className="text-[13px]"
          />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <Label>Parent id (optional)</Label>
          <input
            value={parentId}
            onChange={(e) => onParent(e.target.value)}
            placeholder="#123 or provider-id"
            className="mt-2 w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none"
          />
        </div>
        <div>
          <Label>Assignee (optional)</Label>
          <input
            value={assignee}
            onChange={(e) => onAssignee(e.target.value)}
            placeholder="@me or user handle"
            className="mt-2 w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none"
          />
        </div>
        <div>
          <Label>Tags (comma-separated)</Label>
          <input
            value={tagsRaw}
            onChange={(e) => onTags(e.target.value)}
            placeholder="triage, ux, regression"
            className="mt-2 w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none"
          />
        </div>
      </div>
    </div>
  );
}

function DuplicatesPanel({
  loading,
  duplicates,
}: {
  loading: boolean;
  duplicates: DTO["ItemDTO"][];
}) {
  if (loading && duplicates.length === 0) {
    return <p className="text-xs text-fg-muted">Checking for duplicates…</p>;
  }
  if (duplicates.length === 0) return null;
  return (
    <div className="rounded-xl border border-warning bg-warning-bg/40 px-3 py-2 text-xs text-warning-fg">
      <div className="mb-1 font-semibold">Possible duplicates ({duplicates.length})</div>
      <ul className="flex flex-col gap-0.5 font-mono text-[11px]">
        {duplicates.map((it) => (
          <li key={it.id} className="truncate">
            <a
              href={`/items/${encodeURIComponent(it.id)}`}
              target="_blank"
              rel="noreferrer"
              className="hover:underline"
            >
              [{it.id}] {it.title}
            </a>
            <span className="ml-2 text-fg-muted">— {formatState(it.state)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
