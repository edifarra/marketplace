import { supabaseAdmin } from "./supabase-admin";

export const MARKETPLACE_ACCOUNT_COLUMNS = [
  "id",
  "name",
  "marketplace",
  "account_id",
  "seller_id",
  "shop_id",
  "nickname",
  "email",
  "category_id",
  "client_id",
  "client_secret",
  "redirect_uri",
  "api_base_url",
  "access_token",
  "refresh_token",
  "token_expires_at",
  "scope",
  "token_type",
  "status",
  "last_sync_at",
  "last_inventory_sync_at",
  "last_error",
  "active",
  "raw_data",
  "created_at",
  "updated_at"
];

export type MarketplaceAccountView = Record<string, unknown> & {
  id: string;
  name: string;
  marketplace: string;
  active: boolean;
  account_id?: string | null;
  seller_id?: string | null;
  shop_id?: string | null;
  nickname?: string | null;
  email?: string | null;
  access_token?: string | null;
  refresh_token?: string | null;
  status?: string | null;
  last_sync_at?: string | null;
  last_inventory_sync_at?: string | null;
  last_error?: string | null;
};

export async function listMarketplaceAccountViews() {
  const rows = await listMarketplaceAccountRows();
  return rows.map(toMarketplaceAccountView);
}

export async function listMarketplaceAccountRows() {
  return selectMarketplaceAccountRows();
}

export async function markMarketplaceReconnectStarted(accountId: string) {
  await updateMarketplaceAccountColumns(accountId, {
    last_sync_at: new Date().toISOString(),
    last_error: null
  });
}

export async function updateMarketplaceAccountColumns(accountId: string, payload: Record<string, unknown>) {
  let currentPayload = { ...payload };

  for (let attempt = 0; attempt < Object.keys(payload).length; attempt += 1) {
    const result = await supabaseAdmin()
      .from("config_marketplace_accounts")
      .update(currentPayload)
      .eq("id", accountId);

    if (!result.error) {
      return;
    }

    const missingColumn = extractMissingColumn(result.error.message);
    if (!missingColumn || !(missingColumn in currentPayload)) {
      throw new Error(result.error.message);
    }

    delete currentPayload[missingColumn];
  }
}

export function marketplaceDisplayStatus(row: Record<string, unknown>) {
  if (!toBoolean(row.active)) {
    return "Inativo";
  }

  if (row.access_token || row.refresh_token) {
    return "Active";
  }

  const status = String(row.status || "");
  if (!status || status === "disconnected") {
    return "-";
  }

  const labels: Record<string, string> = {
    active: "Active",
    disconnected: "Disconnected",
    inactive: "Inactive",
    error: "Error"
  };

  return labels[status] || status;
}

export function formatMarketplaceDateTime(value: unknown) {
  if (!value) {
    return "-";
  }

  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date).replace(",", "");
}

async function selectMarketplaceAccountRows() {
  let selectedColumns = [...MARKETPLACE_ACCOUNT_COLUMNS];

  for (let attempt = 0; attempt < MARKETPLACE_ACCOUNT_COLUMNS.length; attempt += 1) {
    const result = await supabaseAdmin()
      .from("config_marketplace_accounts")
      .select(selectedColumns.join(","))
      .order("name");

    if (!result.error) {
      return fillMissingMarketplaceFields(result.data ?? []);
    }

    const missingColumn = extractMissingColumn(result.error.message);
    if (!missingColumn || !selectedColumns.includes(missingColumn)) {
      throw new Error(result.error.message);
    }

    selectedColumns = selectedColumns.filter((column) => column !== missingColumn);
  }

  return [];
}

function fillMissingMarketplaceFields(data: unknown[]) {
  return (data as Record<string, unknown>[]).map((row) => {
    for (const column of MARKETPLACE_ACCOUNT_COLUMNS) {
      if (!(column in row)) {
        row[column] = null;
      }
    }
    return row;
  });
}

function toMarketplaceAccountView(row: Record<string, unknown>) {
  return {
    ...row,
    status: marketplaceDisplayStatus(row),
    last_sync_at: formatMarketplaceDateTime(row.last_sync_at),
    last_inventory_sync_at: formatMarketplaceDateTime(row.last_inventory_sync_at),
    token_expires_at: formatMarketplaceDateTime(row.token_expires_at)
  } as unknown as MarketplaceAccountView;
}

function toBoolean(value: unknown) {
  return value === true || value === "true" || value === 1;
}

function extractMissingColumn(message: string) {
  const patterns = [
    /column\s+[^.]+\.(\w+)\s+does not exist/i,
    /Could not find the ['"]?(\w+)['"]? column/i,
    /Could not find ['"]?(\w+)['"]? in the schema cache/i
  ];

  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  return "";
}
