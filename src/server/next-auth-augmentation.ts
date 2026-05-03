import type { UserId } from "@/core/types";

declare module "next-auth" {
  interface User {
    id: UserId;
  }
}
