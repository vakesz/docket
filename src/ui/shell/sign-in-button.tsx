import { secondaryButtonClass } from "@/lib/form-classes";
import { nextAuthProviderId } from "@/lib/next-auth-provider-id";
import { ProviderLogo } from "@/lib/provider-logos";
import { signIn } from "@/server/auth";
import { db } from "@/server/db";
import { logger } from "@/server/logger";

export async function SignInButtons({ redirectTo = "/" }: { redirectTo?: string }) {
  // Render one button per enabled OauthProviderConfig row so a new provider
  // (DB-seeded or admin-added) lights up its sign-in path with no code edit.
  // Labels come from `row.label` — the admin UI controls what users see;
  // we never enumerate kinds here. Explicit `select` keeps `clientSecret`
  // ciphertext out of the server component's memory entirely.
  let rows: Array<{ id: string; kind: string; label: string }> = [];
  try {
    rows = await db.oauthProviderConfig.findMany({
      where: { enabled: true },
      orderBy: [{ kind: "asc" }],
      select: { id: true, kind: true, label: true },
    });
  } catch (err) {
    logger.error({ err }, "[sign-in] failed to load OAuth providers");
    rows = [];
  }

  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No sign-in providers configured. Ask an admin to add one in settings.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {rows.map((row) => {
        const providerId = nextAuthProviderId(row.kind);
        const label = row.label || row.kind;
        return (
          <form
            key={row.id}
            action={async () => {
              "use server";
              await signIn(providerId, { redirectTo });
            }}
          >
            <button
              type="submit"
              className={`${secondaryButtonClass} inline-flex items-center justify-center gap-2`}
            >
              <ProviderLogo kind={row.kind} className="h-4 w-4" />
              Sign in with {label}
            </button>
          </form>
        );
      })}
    </div>
  );
}
