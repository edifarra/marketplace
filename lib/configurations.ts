import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { supabaseAdmin } from "./supabase-admin";

export type ConfigSection = "tipo" | "marca" | "especial" | "preco" | "sku" | "marketplace" | "tiny" | "cloudinary" | "config-geral";

type FieldType = "text" | "number" | "textarea" | "checkbox" | "json";

export type ConfigField = {
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
};

type ConfigDefinition = {
  title: string;
  description: string;
  table: string;
  keyField: string;
  searchFields: string[];
  fields: ConfigField[];
  listFields: string[];
  hiddenFields?: string[];
  fixedRows?: string[];
  marker?: string;
};

export const configDefinitions: Record<ConfigSection, ConfigDefinition> = {
  tipo: {
    title: "Tipo",
    description: "Tipos de produto, grupos de SKU, medidas, templates e garantia.",
    table: "config_types",
    keyField: "code",
    searchFields: ["code", "description", "sku_group", "marketplace_category"],
    listFields: ["code", "description", "sku_group", "sku_max", "marketplace_category"],
    fields: [
      { name: "code", label: "Sigla", type: "text", required: true },
      { name: "description", label: "Descricao", type: "text", required: true },
      { name: "sku_max", label: "SKU Max", type: "number" },
      { name: "marketplace_category", label: "Categoria", type: "text" },
      { name: "weight_net", label: "Peso liquido", type: "number" },
      { name: "weight_gross", label: "Peso bruto", type: "number" },
      { name: "width", label: "Largura", type: "number" },
      { name: "height", label: "Altura", type: "number" },
      { name: "length", label: "Comprimento", type: "number" },
      { name: "sku_group", label: "Grupo SKU", type: "text", required: true },
      { name: "warranty_months", label: "Garantia meses", type: "number" },
      { name: "title_template", label: "Template titulo", type: "textarea" },
      { name: "description_template", label: "Template descricao", type: "textarea" }
    ]
  },
  marca: {
    title: "Marca",
    description: "Marcas usadas na montagem do titulo e descricao.",
    table: "config_brands",
    keyField: "code",
    searchFields: ["code", "name"],
    listFields: ["code", "name", "include_in_title"],
    fields: [
      { name: "code", label: "Sigla", type: "text", required: true },
      { name: "name", label: "Marca", type: "text", required: true },
      { name: "include_in_title", label: "Incluir no titulo", type: "checkbox" }
    ]
  },
  especial: {
    title: "Especial",
    description: "Regras especiais de descricao e garantia.",
    table: "config_specials",
    keyField: "code",
    searchFields: ["code", "include_description", "remove_description", "notes"],
    listFields: ["code", "include_description", "keep_warranty", "notes"],
    fields: [
      { name: "code", label: "Codigo", type: "text", required: true },
      { name: "include_description", label: "Incluir descricao", type: "textarea" },
      { name: "remove_description", label: "Remover descricao", type: "textarea" },
      { name: "keep_warranty", label: "Manter garantia", type: "checkbox" },
      { name: "notes", label: "Observacoes", type: "textarea" }
    ]
  },
  preco: {
    title: "Preco",
    description: "Parametros usados no calculo e busca de preco.",
    table: "settings",
    keyField: "key",
    searchFields: ["key", "description"],
    listFields: ["key", "value", "description"],
    fixedRows: [
      "QUANTIDADE_ANUNCIOS_RECUPERADOS",
      "QUANTIDADE_ANUNCIOS_PARA_CALCULO",
      "DEFINICAO_PRECO",
      "TIPO_DEFLATOR",
      "VALOR_DEPLATOR",
      "VALOR_MINIMO",
      "PERCENTUAL_OUTLIER_INFERIOR",
      "VALORES_EM_GAP"
    ],
    marker: "[PRECO]",
    fields: [
      { name: "key", label: "Parametro", type: "text", required: true },
      { name: "value", label: "Valor", type: "json", required: true },
      { name: "description", label: "Descricao", type: "textarea" }
    ]
  },
  sku: {
    title: "Sku",
    description: "Sequenciais de SKU existentes no banco de dados.",
    table: "sku_counters",
    keyField: "sku_group",
    searchFields: ["sku_group", "current_number"],
    listFields: ["sku_group", "current_number", "updated_at"],
    fields: [
      { name: "sku_group", label: "Grupo SKU", type: "text", required: true },
      { name: "current_number", label: "Sequencial atual", type: "number", required: true }
    ]
  },
  marketplace: {
    title: "MarketPlace",
    description: "Contas, lojas e credenciais OAuth para envio e consulta de anuncios.",
    table: "config_marketplace_accounts",
    keyField: "id",
    searchFields: ["name", "marketplace", "account_id", "seller_id", "category_id"],
    listFields: ["name", "marketplace", "account_id", "seller_id", "category_id", "active", "last_inventory_sync_at", "last_error"],
    hiddenFields: ["access_token", "refresh_token"],
    fields: [
      { name: "name", label: "Nome", type: "text", required: true },
      { name: "marketplace", label: "Marketplace (mercado_livre ou shopee)", type: "text", required: true },
      { name: "account_id", label: "Conta/Loja", type: "text" },
      { name: "seller_id", label: "Seller/User ID", type: "text" },
      { name: "category_id", label: "Categoria padrao", type: "text" },
      { name: "client_id", label: "Client ID / App ID", type: "text" },
      { name: "client_secret", label: "Client Secret", type: "text" },
      { name: "redirect_uri", label: "Redirect URI HTTPS (opcional se NEXT_PUBLIC_APP_URL estiver configurado)", type: "text" },
      { name: "access_token", label: "Access Token", type: "textarea" },
      { name: "refresh_token", label: "Refresh Token", type: "textarea" },
      { name: "token_expires_at", label: "Token expira em", type: "text" },
      { name: "scope", label: "Escopos", type: "text" },
      { name: "token_type", label: "Tipo token", type: "text" },
      { name: "active", label: "Ativo", type: "checkbox" }
    ]
  },
  tiny: {
    title: "Tiny",
    description: "Credenciais e parametros para criacao de produtos no Tiny.",
    table: "settings",
    keyField: "key",
    searchFields: ["key", "description"],
    listFields: ["key", "value", "description"],
    fixedRows: [
      "TINY_TOKEN",
      "OLIST_TINY_COOKIE",
      "TINY_ENDPOINT_INCLUIR_PRODUTO",
      "TINY_ENDPOINT_ALTERAR_PRODUTO",
      "TINY_FORMATO",
      "ORIGEM_PRODUTO",
      "SITUACAO_PRODUTO",
      "CLASSE_PRODUTO",
      "SOB_ENCOMENDA"
    ],
    marker: "[TINY]",
    fields: [
      { name: "key", label: "Parametro", type: "text", required: true },
      { name: "value", label: "Valor", type: "json", required: true },
      { name: "description", label: "Descricao", type: "textarea" }
    ]
  },
  cloudinary: {
    title: "Cloudinary",
    description: "Credenciais usadas para subir e transformar as imagens dos produtos.",
    table: "settings",
    keyField: "key",
    searchFields: ["key", "description"],
    listFields: ["key", "value", "description"],
    fixedRows: [
      "CLOUDINARY_CLOUD_NAME",
      "CLOUDINARY_API_KEY",
      "CLOUDINARY_API_SECRET"
    ],
    marker: "[CLOUDINARY]",
    fields: [
      { name: "key", label: "Parametro", type: "text", required: true },
      { name: "value", label: "Valor", type: "json", required: true },
      { name: "description", label: "Descricao", type: "textarea" }
    ]
  },
  "config-geral": {
    title: "ConfigGeral",
    description: "Parametros gerais do sistema.",
    table: "settings",
    keyField: "key",
    searchFields: ["key", "description"],
    listFields: ["key", "value", "description"],
    fixedRows: [
      "ESTOQUE_INICIAL",
      "MAX_FOTOS",
      "PAUSAR_COM_ESTOQUE_ZERO",
      "MODO_SAIDA_PRODUTO",
      "CRIAR_PRODUTO_TINY_API",
      "ENVIAR_MARKETPLACE_AUTOMATICO"
    ],
    marker: "[CONFIG_GERAL]",
    fields: [
      { name: "key", label: "Parametro", type: "text", required: true },
      { name: "value", label: "Valor", type: "json", required: true },
      { name: "description", label: "Descricao", type: "textarea" }
    ]
  }
};

export function isConfigSection(value: string): value is ConfigSection {
  return value in configDefinitions;
}

export async function getConfigurationPageData(section: ConfigSection, query: string, editKey?: string) {
  const definition = configDefinitions[section];
  const supabase = supabaseAdmin();
  const columns = [...new Set([
    definition.keyField,
    ...definition.listFields,
    ...(definition.hiddenFields || []),
    ...definition.fields.map((field) => field.name)
  ])].join(",");
  let request = supabase.from(definition.table).select(columns);

  if (definition.fixedRows?.length && definition.table !== "settings") {
    request = request.in(definition.keyField, definition.fixedRows);
  }

  const { data } = await request.order(definition.keyField).throwOnError();
  const allRows = (data ?? []) as unknown as Record<string, unknown>[];
  const rows = ensureFixedSettingsRows(filterSectionRows(allRows, definition), definition);
  const filteredRows = filterRows(rows, definition.searchFields, query);
  const editRow = editKey ? rows.find((row) => String(row[definition.keyField]) === editKey) : undefined;

  return {
    definition,
    rows: filteredRows,
    editRow,
    query
  };
}

export async function saveConfiguration(formData: FormData) {
  const section = getSection(formData);
  const definition = configDefinitions[section];
  const originalKey = optionalString(formData.get("originalKey"));
  const payload = parsePayload(definition, formData);
  applySettingsMarker(definition, payload);
  const supabase = supabaseAdmin();

  const result = originalKey && definition.table === "settings"
    ? await supabase.from(definition.table).upsert(payload, { onConflict: definition.keyField })
    : originalKey
    ? await supabase.from(definition.table).update(payload).eq(definition.keyField, originalKey)
    : await supabase.from(definition.table).insert(payload);

  if (result.error) {
    redirect(`/configuracoes/${section}?erro=${encodeURIComponent(result.error.message)}`);
  }

  revalidatePath("/");
  revalidatePath(`/configuracoes/${section}`);
  redirect(`/configuracoes/${section}`);
}

export async function deleteConfiguration(formData: FormData) {
  const section = getSection(formData);
  const definition = configDefinitions[section];
  const key = requiredString(formData.get("key"), "key");
  const supabase = supabaseAdmin();

  if (["undefined", "null"].includes(key.toLowerCase())) {
    redirect(`/configuracoes/${section}?erro=${encodeURIComponent("Registro sem identificador valido para exclusao.")}`);
  }

  if (section === "marketplace") {
    const cleanupError = await cleanupMarketplaceAccountDependencies(key);
    if (cleanupError) {
      redirect(`/configuracoes/${section}?erro=${encodeURIComponent(cleanupError)}`);
    }
  }

  const result = await supabase.from(definition.table).delete().eq(definition.keyField, key);
  if (result.error) {
    redirect(`/configuracoes/${section}?erro=${encodeURIComponent(result.error.message)}`);
  }

  revalidatePath("/");
  revalidatePath(`/configuracoes/${section}`);
  redirect(`/configuracoes/${section}`);
}

async function cleanupMarketplaceAccountDependencies(accountId: string) {
  const supabase = supabaseAdmin();

  const productMarketplaceResult = await supabase
    .from("product_marketplaces")
    .delete()
    .eq("marketplace_account_id", accountId);

  if (productMarketplaceResult.error && !/schema cache|Could not find|relation .* does not exist/i.test(productMarketplaceResult.error.message)) {
    return productMarketplaceResult.error.message;
  }

  const listingsResult = await supabase
    .from("listings")
    .delete()
    .eq("marketplace_account_id", accountId);

  if (listingsResult.error) {
    return listingsResult.error.message;
  }

  return "";
}

function filterRows(rows: Record<string, unknown>[], fields: string[], query: string) {
  const normalizedQuery = normalizeSearch(query);
  if (!normalizedQuery) {
    return rows;
  }

  return rows.filter((row) =>
    fields.some((field) => normalizeSearch(formatValue(row[field])).includes(normalizedQuery))
  );
}

function filterSectionRows(rows: Record<string, unknown>[], definition: ConfigDefinition) {
  if (definition.table !== "settings" || !definition.fixedRows?.length) {
    return rows;
  }

  return rows.filter((row) => {
    const key = String(row[definition.keyField] || "");
    const description = String(row.description || "");
    return definition.fixedRows?.includes(key) || (!!definition.marker && description.includes(definition.marker));
  });
}

function ensureFixedSettingsRows(rows: Record<string, unknown>[], definition: ConfigDefinition) {
  if (definition.table !== "settings" || !definition.fixedRows?.length) {
    return rows;
  }

  const existingKeys = new Set(rows.map((row) => String(row[definition.keyField] || "")));
  const missingRows: Record<string, unknown>[] = definition.fixedRows
    .filter((key) => !existingKeys.has(key))
    .map((key) => ({
      key,
      value: "",
      description: `${definition.marker || ""} ${defaultSettingDescription(key)}`.trim()
    }));

  return [...rows, ...missingRows].sort((a, b) =>
    String(a[definition.keyField] || "").localeCompare(String(b[definition.keyField] || ""))
  );
}

function defaultSettingDescription(key: string) {
  const descriptions: Record<string, string> = {
    CLOUDINARY_CLOUD_NAME: "Nome da cloud usado na URL de upload.",
    CLOUDINARY_API_KEY: "API Key da conta Cloudinary.",
    CLOUDINARY_API_SECRET: "API Secret usado para assinar uploads.",
    TINY_TOKEN: "Token da API Tiny para incluir produtos.",
    OLIST_TINY_COOKIE: "Cookie da Olist/Tiny usado em fluxos internos de marketplace.",
    TINY_ENDPOINT_INCLUIR_PRODUTO: "Endpoint da API Tiny para incluir produto.",
    TINY_ENDPOINT_ALTERAR_PRODUTO: "Endpoint da API Tiny para atualizar produto.",
    TINY_FORMATO: "Formato da resposta da API Tiny.",
    ORIGEM_PRODUTO: "Origem do produto enviada ao Tiny.",
    SITUACAO_PRODUTO: "Situacao do produto enviada ao Tiny.",
    CLASSE_PRODUTO: "Classe do produto enviada ao Tiny.",
    SOB_ENCOMENDA: "Indicador de produto sob encomenda no Tiny."
  };

  return descriptions[key] || "Parametro do sistema.";
}

export function formatValue(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return "-";
  }

  if (typeof value === "boolean") {
    return value ? "Sim" : "Nao";
  }

  if (typeof value === "object") {
    return JSON.stringify(value);
  }

  return String(value);
}

function parsePayload(definition: ConfigDefinition, formData: FormData) {
  const payload: Record<string, unknown> = {};

  for (const field of definition.fields) {
    const raw = formData.get(field.name);

    if (field.type === "checkbox") {
      payload[field.name] = raw === "on";
      continue;
    }

    const value = optionalString(raw);
    if (field.required && !value) {
      throw new Error(`Campo obrigatorio: ${field.label}`);
    }

    if (!value) {
      payload[field.name] = null;
      continue;
    }

    if (field.type === "number") {
      payload[field.name] = Number(value.replace(",", "."));
      continue;
    }

    if (field.type === "json") {
      payload[field.name] = parseJsonish(value);
      continue;
    }

    payload[field.name] = value;
  }

  return payload;
}

function applySettingsMarker(definition: ConfigDefinition, payload: Record<string, unknown>) {
  if (definition.table !== "settings" || !definition.marker) {
    return;
  }

  const description = String(payload.description || "").trim();
  payload.description = description.includes(definition.marker)
    ? description
    : `${definition.marker} ${description}`.trim();
}

function parseJsonish(value: string) {
  const trimmed = value.trim();
  if (["true", "false"].includes(trimmed.toLowerCase())) {
    return trimmed.toLowerCase() === "true";
  }

  const numeric = Number(trimmed.replace(",", "."));
  if (Number.isFinite(numeric) && trimmed !== "") {
    return numeric;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function getSection(formData: FormData) {
  const section = requiredString(formData.get("section"), "section");
  if (!isConfigSection(section)) {
    throw new Error("Configuracao invalida.");
  }

  return section;
}

function requiredString(value: FormDataEntryValue | null, field: string) {
  const text = optionalString(value);
  if (!text) {
    throw new Error(`Campo obrigatorio: ${field}`);
  }

  return text;
}

function optionalString(value: FormDataEntryValue | null) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeSearch(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}
