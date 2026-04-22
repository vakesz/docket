import { createFileRoute } from "@tanstack/react-router";

import { ItemDetail } from "~/components/detail/ItemDetail";

export const Route = createFileRoute("/items/$itemId")({
  component: ItemDetailRoute,
});

function ItemDetailRoute() {
  const { itemId } = Route.useParams();
  return <ItemDetail itemId={itemId} />;
}
