"use client";

import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc-client";
import { Alert, AlertDescription } from "@/ui/primitives/alert";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/primitives/select";

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
        <h3 className="font-medium text-foreground text-sm">
          {cap?.label ?? "LLM monthly cost cap (cents)"}
        </h3>
        <p className="text-muted-foreground text-xs">
          {cap?.description ??
            "Hard ceiling on the sum of `Conversation.costCents` accrued in the current calendar month (UTC). 0 disables the cap."}
        </p>
        {budget.data ? (
          <p className="text-muted-foreground/70 text-xs">
            This month: ${(budget.data.monthCents / 100).toFixed(2)}
            {budget.data.capCents > 0
              ? ` of $${(budget.data.capCents / 100).toFixed(2)} (${budget.data.capReached ? "cap reached" : `$${(budget.data.remainingCents / 100).toFixed(2)} remaining`})`
              : " — no cap configured"}
          </p>
        ) : null}
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-xs">$</span>
          <Input
            type="number"
            inputMode="decimal"
            min={0}
            step={1}
            value={capDollars}
            disabled={list.isPending || update.isPending}
            onChange={(e) => setCapDollars(e.target.value)}
            className="max-w-[10rem]"
          />
          <Button type="button" onClick={onSaveCap} disabled={update.isPending}>
            Save cap
          </Button>
        </div>
        <div className="flex flex-col gap-1">
          <span className="font-medium text-foreground text-xs">
            {action?.label ?? "When cap is reached"}
          </span>
          <p className="text-muted-foreground text-xs">
            {action?.description ??
              "'warn' lets the turn proceed but surfaces a banner; 'block' refuses agent turns until the cap is raised or the calendar month rolls over."}
          </p>
          <Select
            value={typeof action?.value === "string" ? action.value : "warn"}
            disabled={list.isPending || update.isPending}
            onValueChange={(value) => update.mutate({ key: "llm.cost-cap-action" as never, value })}
          >
            <SelectTrigger className="max-w-[14rem]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="warn">warn (allow + banner)</SelectItem>
              <SelectItem value="block">block (refuse turns)</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </section>

      <section className="flex flex-col gap-2 border-border border-t pt-4 first:border-t-0 first:pt-0">
        <h3 className="font-medium text-foreground text-sm">
          {retention?.label ?? "Audit retention (days)"}
        </h3>
        <p className="text-muted-foreground text-xs">
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
            className="max-w-[8rem]"
          />
          <Button type="button" onClick={onSaveRetention} disabled={update.isPending}>
            Save retention
          </Button>
        </div>
        {audit.data ? (
          <p className="text-muted-foreground/70 text-xs">
            Total audit rows: {audit.data.total.toLocaleString()}.
            {audit.data.retentionDays > 0
              ? ` ${audit.data.eligible.toLocaleString()} older than ${audit.data.retentionDays} day${audit.data.retentionDays === 1 ? "" : "s"} are eligible for pruning.`
              : " Retention is disabled — no rows are eligible for pruning."}
          </p>
        ) : null}
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="destructive"
            onClick={() => prune.mutate()}
            disabled={
              prune.isPending ||
              !audit.data ||
              audit.data.retentionDays === 0 ||
              audit.data.eligible === 0
            }
          >
            {prune.isPending ? "Pruning…" : "Prune eligible rows"}
          </Button>
          {prune.data?.ok ? (
            <span className="text-muted-foreground text-xs">
              Pruned {prune.data.deleted.toLocaleString()} row{prune.data.deleted === 1 ? "" : "s"}.
            </span>
          ) : null}
          {prune.error ? (
            <span className="text-destructive text-xs">{prune.error.message}</span>
          ) : null}
        </div>
      </section>

      {update.error ? (
        <Alert variant="destructive">
          <AlertDescription>{update.error.message}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
