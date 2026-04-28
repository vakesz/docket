"use client";

import { Input } from "@headlessui/react";
import { useEffect, useState } from "react";
import {
  dangerButtonClass,
  fieldClass,
  primaryButtonClass,
  settingsRowClass,
} from "@/lib/form-classes";
import { trpc } from "@/lib/trpc-client";
import { SelectField } from "@/ui/forms/select-field";

/**
 * Deployment-hub panel for the LLM monthly cost cap and the audit
 * retention window. Both knobs are global Settings; the prune action
 * uses `mutationProcedure` so it respects read-only mode.
 */
export function BudgetAuditPanel() {
  const utils = trpc.useUtils();
  const list = trpc.settings.globalList.useQuery();
  const audit = trpc.settings.auditStatus.useQuery();
  const budget = trpc.settings.budgetStatus.useQuery();

  const update = trpc.settings.globalUpdate.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.settings.globalList.invalidate(),
        utils.settings.auditStatus.invalidate(),
        utils.settings.budgetStatus.invalidate(),
      ]);
    },
  });

  const prune = trpc.settings.auditPrune.useMutation({
    onSuccess: async () => {
      await utils.settings.auditStatus.invalidate();
    },
  });

  const retention = list.data?.find((r) => r.key === "audit.retention-days");
  const cap = list.data?.find((r) => r.key === "llm.monthly-cost-cap-cents");
  const action = list.data?.find((r) => r.key === "llm.cost-cap-action");

  const [retentionInput, setRetentionInput] = useState<string>("");
  const [capDollars, setCapDollars] = useState<string>("");

  useEffect(() => {
    if (typeof retention?.value === "number") setRetentionInput(String(retention.value));
  }, [retention?.value]);

  useEffect(() => {
    if (typeof cap?.value === "number") setCapDollars((cap.value / 100).toFixed(2));
  }, [cap?.value]);

  const onSaveRetention = () => {
    const n = Number.parseInt(retentionInput, 10);
    if (!Number.isFinite(n) || n < 0 || n > 3650) return;
    update.mutate({ key: "audit.retention-days" as never, value: n });
  };

  const onSaveCap = () => {
    const dollars = Number.parseFloat(capDollars);
    if (!Number.isFinite(dollars) || dollars < 0) return;
    const cents = Math.round(dollars * 100);
    if (cents > 10_000_000) return;
    update.mutate({ key: "llm.monthly-cost-cap-cents" as never, value: cents });
  };

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-fg">
          {cap?.label ?? "LLM monthly cost cap (cents)"}
        </h3>
        <p className="text-xs text-fg-muted">
          {cap?.description ??
            "Hard ceiling on the sum of `Conversation.costCents` accrued in the current calendar month (UTC). 0 disables the cap."}
        </p>
        {budget.data ? (
          <p className="text-xs text-fg-faint">
            This month: ${(budget.data.monthCents / 100).toFixed(2)}
            {budget.data.capCents > 0
              ? ` of $${(budget.data.capCents / 100).toFixed(2)} (${budget.data.capReached ? "cap reached" : `$${(budget.data.remainingCents / 100).toFixed(2)} remaining`})`
              : " — no cap configured"}
          </p>
        ) : null}
        <div className="flex items-center gap-2">
          <span className="text-xs text-fg-muted">$</span>
          <Input
            type="number"
            inputMode="decimal"
            min={0}
            step={1}
            value={capDollars}
            disabled={list.isPending || update.isPending}
            onChange={(e) => setCapDollars(e.target.value)}
            className={`${fieldClass} max-w-[10rem]`}
          />
          <button
            type="button"
            onClick={onSaveCap}
            disabled={update.isPending}
            className={primaryButtonClass}
          >
            Save cap
          </button>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-fg">
            {action?.label ?? "When cap is reached"}
          </span>
          <p className="text-xs text-fg-muted">
            {action?.description ??
              "'warn' lets the turn proceed but surfaces a banner; 'block' refuses agent turns until the cap is raised or the calendar month rolls over."}
          </p>
          <SelectField
            value={typeof action?.value === "string" ? action.value : "warn"}
            disabled={list.isPending || update.isPending}
            onChange={(e) =>
              update.mutate({ key: "llm.cost-cap-action" as never, value: e.target.value })
            }
            wrapperClassName="max-w-[10rem]"
          >
            <option value="warn">warn (allow + banner)</option>
            <option value="block">block (refuse turns)</option>
          </SelectField>
        </div>
      </section>

      <section className={settingsRowClass}>
        <h3 className="text-sm font-medium text-fg">
          {retention?.label ?? "Audit retention (days)"}
        </h3>
        <p className="text-xs text-fg-muted">
          {retention?.description ??
            "Audit rows older than this are eligible for pruning. 0 disables pruning entirely."}
        </p>
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min={0}
            max={3650}
            step={1}
            value={retentionInput}
            disabled={list.isPending || update.isPending}
            onChange={(e) => setRetentionInput(e.target.value)}
            className={`${fieldClass} max-w-[8rem]`}
          />
          <button
            type="button"
            onClick={onSaveRetention}
            disabled={update.isPending}
            className={primaryButtonClass}
          >
            Save retention
          </button>
        </div>
        {audit.data ? (
          <p className="text-xs text-fg-faint">
            Total audit rows: {audit.data.total.toLocaleString()}.
            {audit.data.retentionDays > 0
              ? ` ${audit.data.eligible.toLocaleString()} older than ${audit.data.retentionDays} day${audit.data.retentionDays === 1 ? "" : "s"} are eligible for pruning.`
              : " Retention is disabled — no rows are eligible for pruning."}
          </p>
        ) : null}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => prune.mutate()}
            disabled={
              prune.isPending ||
              !audit.data ||
              audit.data.retentionDays === 0 ||
              audit.data.eligible === 0
            }
            className={dangerButtonClass}
          >
            {prune.isPending ? "Pruning…" : "Prune eligible rows"}
          </button>
          {prune.data?.ok ? (
            <span className="text-xs text-fg-muted">
              Pruned {prune.data.deleted.toLocaleString()} row{prune.data.deleted === 1 ? "" : "s"}.
            </span>
          ) : null}
          {prune.error ? (
            <span className="text-xs text-danger-fg">{prune.error.message}</span>
          ) : null}
        </div>
      </section>

      {update.error ? <p className="text-xs text-danger-fg">{update.error.message}</p> : null}
    </div>
  );
}
