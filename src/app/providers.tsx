"use client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchStreamLink } from "@trpc/client";
import { useState } from "react";
import superjson from "superjson";
import { publicBaseUrl } from "@/lib/public-base-url";
import { trpc } from "@/lib/trpc-client";

function getBaseUrl(): string {
  if (typeof window !== "undefined") return "";
  return publicBaseUrl();
}

export function AppProviders({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );
  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [
        // httpBatchStreamLink streams individual procedure responses as the
        // server resolves them, instead of waiting for the slowest one in
        // the batch. UX wins: backlog rows + facets can paint before
        // settings + me + project finish.
        httpBatchStreamLink({
          url: `${getBaseUrl()}/api/trpc`,
          transformer: superjson,
        }),
      ],
    }),
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}
