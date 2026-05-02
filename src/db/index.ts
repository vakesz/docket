// One import path for the client and schema. Consumers do
// `import { db } from "@/db"` and `import { ... } from "@/db/schema"`. Row-
// shape aliases live at `@/db/schema/types`. No file outside `src/db/` should
// reach into `@/db/schema/<file>` or import drizzle-orm directly.

export { sql } from "drizzle-orm";
export type { Db, DbTx } from "@/db/client";
export { db } from "@/db/client";
