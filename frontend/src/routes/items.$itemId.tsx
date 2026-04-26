import { createFileRoute } from "@tanstack/react-router";

import { ItemDetail } from "~/components/detail/ItemDetail";

export const Route = createFileRoute("/items/$itemId")({
  component: ItemDetailRoute,
});

function ItemDetailRoute() {
  const { itemId } = Route.useParams();
  // `key={itemId}` forces a remount on item switch so per-item local state in
  // ItemDetail and its children (editing flag, in-pane proposal queue, the
  // suggestion card, an in-progress description edit, a half-typed comment)
  // can't bleed from the previous item — composing on item A then clicking
  // through to B would otherwise stage A's draft against B.
  return <ItemDetail key={itemId} itemId={itemId} />;
}
