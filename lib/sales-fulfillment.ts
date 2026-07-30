export type SaleShippingAction = "print_label" | "emit_dce" | "arrange_shipment" | null;

type FulfillmentSale = {
  marketplace: string;
  status_original: string | null;
  raw_data: Record<string, unknown> | null;
};

export function extractSaleShipping(raw: Record<string, unknown>) {
  const payload = (raw.payload || raw) as Record<string, any>;
  return (payload.shipment || payload.order?.shipping || payload.data?.shipment || {}) as Record<string, any>;
}

export function saleShippingAction(sale: FulfillmentSale): SaleShippingAction {
  const raw = (sale.raw_data || {}) as Record<string, any>;
  const shipping = extractSaleShipping(raw);
  if (sale.marketplace === "mercado_livre") {
    if (shipping.status === "ready_to_ship" && String(shipping.substatus || "") === "invoice_pending") {
      return "emit_dce";
    }
    return shipping.status === "ready_to_ship"
      && ["ready_to_print", "printed"].includes(String(shipping.substatus || ""))
      ? "print_label"
      : null;
  }
  if (sale.marketplace !== "shopee") return null;
  const shippingArranged = Boolean(raw.shopee_shipping_arranged_at);
  const status = String(sale.status_original || "").toUpperCase();
  const payload = (raw.payload || raw) as Record<string, any>;
  const packages = Array.isArray(payload.order?.package_list) ? payload.order.package_list : [];
  const packageStatuses = packages.map((item: Record<string, any>) => String(item.logistics_status || "").toUpperCase());
  if (["SHIPPED", "TO_CONFIRM_RECEIVE", "COMPLETED", "CANCELLED", "IN_CANCEL"].includes(status)) {
    return null;
  }
  if (packageStatuses.some((packageStatus: string) =>
    ["LOGISTICS_PICKUP_DONE", "PICKED_UP", "SHIPPED", "DELIVERED", "TO_CONFIRM_RECEIVE"].includes(packageStatus)
  )) {
    return null;
  }
  if (status === "READY_TO_SHIP" && !shippingArranged) return "arrange_shipment";
  if ((shippingArranged && ["READY_TO_SHIP", "PROCESSED", "TO_SHIP"].includes(status)) || status === "PROCESSED") {
    return "print_label";
  }
  return /^(CONFIRMED|TO_SHIP)$/i.test(status) ? "arrange_shipment" : null;
}

export function deferredShipping(sale: FulfillmentSale, now = Date.now()) {
  if (sale.marketplace !== "mercado_livre") return null;
  const raw = sale.raw_data || {};
  const shipping = extractSaleShipping(raw);
  const status = String(shipping.status || "").toLowerCase();
  const substatus = String(shipping.substatus || "").toLowerCase();
  const payload = (raw.payload || raw) as Record<string, any>;
  const candidate = payload.shipmentSla?.expected_date || shipping.lead_time?.buffering?.date;
  if (!candidate || (status !== "pending" && substatus !== "buffered")) return null;

  const dateKey = String(candidate).match(/^(\d{4})-(\d{2})-(\d{2})/)?.slice(1);
  if (!dateKey) return null;
  const [year, month, day] = dateKey;
  const timestamp = new Date(`${year}-${month}-${day}T00:00:00-03:00`).getTime();
  if (!Number.isFinite(timestamp) || now >= timestamp) return null;
  return { timestamp, label: `Enviar em ${day}/${month}` };
}

export function salePostedAt(sale: FulfillmentSale) {
  const raw = (sale.raw_data || {}) as Record<string, any>;
  const savedPostedAt = parseDate(raw.marketplace_posted_at);
  if (savedPostedAt) return savedPostedAt;
  const payload = (raw.payload || raw) as Record<string, any>;
  if (sale.marketplace === "mercado_livre") {
    const history = Array.isArray(payload.shipmentHistory) ? payload.shipmentHistory : [];
    const postedEvents = history.filter((event: Record<string, any>) => {
      const status = String(event.status || "").toLowerCase();
      const substatus = String(event.substatus || "").toLowerCase();
      return status === "shipped" || ["dropped_off", "picked_up", "in_hub", "in_packing_list"].includes(substatus);
    });
    const firstEvent = postedEvents
      .map((event: Record<string, any>) => parseDate(event.date))
      .filter((date: Date | null): date is Date => Boolean(date))
      .sort((left: Date, right: Date) => left.getTime() - right.getTime())[0];
    return firstEvent || parseDate(payload.shipment?.status_history?.date_shipped);
  }
  if (sale.marketplace !== "shopee") return null;
  const order = payload.order || {};
  const packages = Array.isArray(order.package_list) ? order.package_list : [];
  const posted = ["SHIPPED", "TO_CONFIRM_RECEIVE", "COMPLETED"].includes(String(sale.status_original || "").toUpperCase())
    || packages.some((item: Record<string, any>) =>
      ["LOGISTICS_PICKUP_DONE", "PICKED_UP", "SHIPPED", "DELIVERED", "TO_CONFIRM_RECEIVE"]
        .includes(String(item.logistics_status || "").toUpperCase())
    );
  if (!posted) return null;
  const explicitPostedAt = [
    order.pickup_done_time,
    order.shipped_time,
    order.ship_time,
    order.actual_shipping_time,
    ...packages.flatMap((item: Record<string, any>) => [
      item.pickup_done_time,
      item.shipped_time,
      item.ship_time,
      item.actual_shipping_time
    ])
  ].map(parseDate).filter((date: Date | null): date is Date => Boolean(date))
    .sort((left: Date, right: Date) => left.getTime() - right.getTime())[0];
  if (explicitPostedAt) return explicitPostedAt;
  return String(sale.status_original || "").toUpperCase() === "SHIPPED"
    ? parseDate(order.update_time || payload.notification?.timestamp || payload.notification?.update_time)
    : null;
}

function parseDate(value: unknown) {
  if (!value) return null;
  const numeric = Number(value);
  const date = Number.isFinite(numeric) && numeric > 0
    ? new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric)
    : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date : null;
}
