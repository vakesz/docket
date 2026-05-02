import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { oauthProviderConfigs } from "@/db/schema";
import { ProviderLogo } from "@/lib/provider-logos";
import { signIn } from "@/server/auth";
import { logger } from "@/server/logger";
import { Button } from "@/ui/primitives/button";

export async function SignInButtons({ redirectTo = "/" }: { redirectTo?: string }) {
  // Render one button per enabled OauthProviderConfig row so a new provider
  // (DB-seeded or admin-added) lights up its sign-in path with no code edit.
  // Labels come from `row.label` — the admin UI controls what users see;
  // we never enumerate kinds here. Explicit `columns` keeps `clientSecret`
  // ciphertext out of the server component's memory entirely.
  let rows: Array<{ id: string; kind: string; label: string }> = [];
  try {
    rows = await db.query.oauthProviderConfigs.findMany({
      where: eq(oauthProviderConfigs.enabled, true),
      orderBy: [asc(oauthProviderConfigs.kind)],
      columns: { id: true, kind: true, label: true },
    });
  } catch (err) {
    logger.error({ err }, "[sign-in] failed to load OAuth providers");
    rows = [];
  }

  if (rows.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No sign-in providers configured. Ask an admin to add one in settings.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {rows.map((row) => {
        const label = row.label || row.kind;
        return (
          <form
            key={row.id}
            action={async () => {
              "use server";
              await signIn(row.kind, { redirectTo });
            }}
          >
            <Button type="submit" variant="outline" className="w-full">
              <ProviderLogo kind={row.kind} className="h-4 w-4" />
              Sign in with {label}
            </Button>
          </form>
        );
      })}
    </div>
  );
}
