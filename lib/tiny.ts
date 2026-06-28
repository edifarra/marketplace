import { supabaseAdmin } from "./supabase-admin";

type TinySettings = {
  token: string;
  endpoint: string;
  updateEndpoint: string;
  formato: string;
  origemProduto: string;
  situacaoProduto: string;
  classeProduto: string;
  sobEncomenda: string;
};

type TinyCreateResult = {
  http: number;
  raw: string;
  json: unknown;
  status: string;
  statusProcessamento: string;
  idProduto: string;
  erros: string;
};

type TinyDeactivateResult = {
  http: number;
  raw: string;
  json: unknown;
  status: string;
  erros: string;
  idProduto: string;
};

export async function createTinyProduct(productId: string): Promise<TinyCreateResult> {
  const supabase = supabaseAdmin();
  const settings = await getTinySettings();
  const { data: product } = await supabase
    .from("products")
    .select("*")
    .eq("id", productId)
    .single()
    .throwOnError();

  const productRecord = product as Record<string, unknown>;
  const [typeConfig, brandConfig, images] = await Promise.all([
    getTinyTypeConfig(String(productRecord.type_code || "")),
    getTinyBrandConfig(String(productRecord.brand_code || "")),
    getTinyProductImages(productId)
  ]);

  const payload = buildTinyProductPayload(
    {
      ...productRecord,
      config_types: typeConfig,
      config_brands: brandConfig,
      product_images: images
    },
    settings
  );
  const body = new URLSearchParams({
    token: settings.token,
    formato: settings.formato,
    produto: JSON.stringify(payload)
  });

  const response = await fetch(settings.endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  const raw = await response.text();
  let json: Record<string, unknown>;

  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`Tiny retornou resposta nao JSON: ${raw}`);
  }

  const retorno = (json.retorno || {}) as Record<string, unknown>;
  const result = {
    http: response.status,
    raw,
    json,
    status: String(retorno.status || "DESCONHECIDO"),
    statusProcessamento: String(retorno.status_processamento || ""),
    idProduto: extractTinyProductId(retorno),
    erros: extractTinyErrors(json)
  };

  if (!response.ok) {
    throw new Error(`Erro HTTP Tiny: ${response.status} | ${raw}`);
  }

  if (result.status !== "OK") {
    throw new Error(`Erro Tiny: ${result.erros || raw}`);
  }

  if (!result.idProduto) {
    throw new Error(`Tiny nao retornou ID do produto. Retorno: ${raw}`);
  }

  return result;
}

export async function updateTinyProduct(productId: string, tinyProductId: string): Promise<TinyCreateResult> {
  const supabase = supabaseAdmin();
  const settings = await getTinySettings();
  const { data: product } = await supabase
    .from("products")
    .select("*")
    .eq("id", productId)
    .single()
    .throwOnError();

  const productRecord = product as Record<string, unknown>;
  const [typeConfig, brandConfig, images] = await Promise.all([
    getTinyTypeConfig(String(productRecord.type_code || "")),
    getTinyBrandConfig(String(productRecord.brand_code || "")),
    getTinyProductImages(productId)
  ]);

  const payload = buildTinyProductPayload(
    {
      ...productRecord,
      tiny_product_id: tinyProductId,
      config_types: typeConfig,
      config_brands: brandConfig,
      product_images: images
    },
    settings
  );
  const body = new URLSearchParams({
    token: settings.token,
    formato: settings.formato,
    produto: JSON.stringify(payload)
  });

  const response = await fetch(settings.updateEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  const raw = await response.text();
  let json: Record<string, unknown>;

  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`Tiny retornou resposta nao JSON ao atualizar produto ${tinyProductId}: ${raw}`);
  }

  const retorno = (json.retorno || {}) as Record<string, unknown>;
  const result = {
    http: response.status,
    raw,
    json,
    status: String(retorno.status || "DESCONHECIDO"),
    statusProcessamento: String(retorno.status_processamento || ""),
    idProduto: extractTinyProductId(retorno) || tinyProductId,
    erros: extractTinyErrors(json)
  };

  if (!response.ok) {
    throw new Error(`Erro HTTP Tiny ao atualizar produto ${tinyProductId}: ${response.status} | ${raw}`);
  }

  if (result.status !== "OK") {
    throw new Error(`Erro Tiny ao atualizar produto ${tinyProductId}: ${result.erros || raw}`);
  }

  return result;
}

export async function deactivateTinyProductById(tinyProductId: string): Promise<TinyDeactivateResult> {
  const settings = await getTinySettings();
  const body = new URLSearchParams({
    token: settings.token,
    formato: settings.formato,
    produto: JSON.stringify({
      id: tinyProductId,
      situacao: "I"
    })
  });

  const response = await fetch(settings.updateEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  const raw = await response.text();
  let json: Record<string, unknown>;

  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`Tiny retornou resposta nao JSON ao inativar produto ${tinyProductId}: ${raw}`);
  }

  const retorno = (json.retorno || {}) as Record<string, unknown>;
  const result = {
    http: response.status,
    raw,
    json,
    status: String(retorno.status || "DESCONHECIDO"),
    erros: extractTinyErrors(json),
    idProduto: extractTinyProductId(retorno) || tinyProductId
  };

  if (!response.ok) {
    throw new Error(`Erro HTTP Tiny ao inativar produto ${tinyProductId}: ${response.status} | ${raw}`);
  }

  if (result.status !== "OK") {
    const errorText = result.erros || raw;
    throw new Error(`Erro Tiny ao inativar produto ${tinyProductId}: ${errorText}`);
  }

  return result;
}

async function getTinyTypeConfig(typeCode: string) {
  if (!typeCode) {
    return {};
  }

  const supabase = supabaseAdmin();
  const { data } = await supabase
    .from("config_types")
    .select("description,marketplace_category,weight_net,weight_gross,width,height,length,warranty_months")
    .eq("code", typeCode)
    .maybeSingle();

  return data || {};
}

async function getTinyBrandConfig(brandCode: string) {
  if (!brandCode) {
    return {};
  }

  const supabase = supabaseAdmin();
  const { data } = await supabase
    .from("config_brands")
    .select("name")
    .eq("code", brandCode)
    .maybeSingle();

  return data || {};
}

async function getTinyProductImages(productId: string) {
  const supabase = supabaseAdmin();
  const withLocal = await supabase
    .from("product_images")
    .select("url,cloudinary_url,local_url,position")
    .eq("product_id", productId)
    .order("position");

  if (!withLocal.error) {
    return withLocal.data || [];
  }

  const fallback = await supabase
    .from("product_images")
    .select("url,position")
    .eq("product_id", productId)
    .order("position");

  return fallback.data || [];
}

function buildTinyProductPayload(product: Record<string, unknown>, settings: TinySettings) {
  const type = (product.config_types || {}) as Record<string, unknown>;
  const brand = (product.config_brands || {}) as Record<string, unknown>;
  const images = ([...((product.product_images || []) as Array<Record<string, unknown>>)])
    .sort((a, b) => Number(a.position || 0) - Number(b.position || 0))
    .map((image) => String(image.cloudinary_url || image.url || image.local_url || ""))
    .map(toTinyImageUrl)
    .filter(Boolean);

  return {
    produtos: [
      {
        produto: {
          sequencia: 1,
          id: product.tiny_product_id ? String(product.tiny_product_id) : undefined,
          nome: limitText(String(product.title || ""), 120),
          codigo: limitText(String(product.sku || ""), 30),
          unidade: "UN",
          preco: formatTinyDecimal(product.price),
          origem: settings.origemProduto,
          situacao: settings.situacaoProduto,
          tipo: "P",
          classe_produto: settings.classeProduto,
          sob_encomenda: settings.sobEncomenda,
          marca: String(brand.name || ""),
          garantia: type.warranty_months ? `${type.warranty_months} meses` : "",
          categoria: String(type.marketplace_category || "").trim().replace(/\s*>\s*/g, " >> "),
          descricao_complementar: String(product.description || ""),
          peso_liquido: formatTinyDecimal(type.weight_net),
          peso_bruto: formatTinyDecimal(type.weight_gross),
          tipo_embalagem: 2,
          largura_embalagem: formatTinyDecimal(type.width),
          altura_embalagem: formatTinyDecimal(type.height),
          comprimento_embalagem: formatTinyDecimal(type.length),
          estoque: Number(product.stock || 0),
          estoque_minimo: 0,
          estoque_maximo: 0,
          imagens_externas: images.map((url) => ({ imagem_externa: { url } })),
          anexos: images.map((url) => ({ anexo: { url } }))
        }
      }
    ]
  };
}

function toTinyImageUrl(url: string) {
  if (!url) {
    return "";
  }

  if (!url.includes("res.cloudinary.com")) {
    return url;
  }

  return url
    .replace("/q_auto:good,w_800,h_800,c_limit,f_auto/", "/q_auto:good,f_jpg,w_800,h_800,c_limit/")
    .replace(/(\.[a-z0-9]+)?(\?.*)?$/i, ".jpg$2");
}

async function getTinySettings(): Promise<TinySettings> {
  const supabase = supabaseAdmin();
  const { data } = await supabase
    .from("settings")
    .select("key,value")
    .in("key", [
      "TINY_TOKEN",
      "TINY_ENDPOINT_INCLUIR_PRODUTO",
      "TINY_ENDPOINT_ALTERAR_PRODUTO",
      "TINY_FORMATO",
      "ORIGEM_PRODUTO",
      "SITUACAO_PRODUTO",
      "CLASSE_PRODUTO",
      "SOB_ENCOMENDA"
    ])
    .throwOnError();

  const settings = new Map((data ?? []).map((row) => [row.key, settingToString(row.value)]));
  return {
    token: requiredTinySetting("TINY_TOKEN", settings.get("TINY_TOKEN") || process.env.TINY_TOKEN),
    endpoint: settings.get("TINY_ENDPOINT_INCLUIR_PRODUTO") || "https://api.tiny.com.br/api2/produto.incluir.php",
    updateEndpoint: settings.get("TINY_ENDPOINT_ALTERAR_PRODUTO") || "https://api.tiny.com.br/api2/produto.alterar.php",
    formato: settings.get("TINY_FORMATO") || "json",
    origemProduto: settings.get("ORIGEM_PRODUTO") || "0",
    situacaoProduto: settings.get("SITUACAO_PRODUTO") || "A",
    classeProduto: settings.get("CLASSE_PRODUTO") || "S",
    sobEncomenda: settings.get("SOB_ENCOMENDA") || "N"
  };
}

function extractTinyProductId(retorno: Record<string, unknown>) {
  const registros = retorno.registros as Array<{ registro?: { id?: unknown } }> | undefined;
  const produto = retorno.produto as { id?: unknown } | undefined;
  return String(registros?.[0]?.registro?.id || produto?.id || "");
}

function extractTinyErrors(json: Record<string, unknown>) {
  const retorno = (json.retorno || {}) as {
    erros?: Array<{ erro?: string }>;
    registros?: Array<{ registro?: { erros?: Array<{ erro?: string }> } }>;
  };
  const topErrors = retorno.erros || [];
  const recordErrors = (retorno.registros || []).flatMap((registro) => registro.registro?.erros || []);
  return [...topErrors, ...recordErrors].map((error) => error.erro || JSON.stringify(error)).join(" | ");
}

function formatTinyDecimal(value: unknown) {
  const numeric = Number(String(value ?? 0).replace(",", "."));
  return (Number.isFinite(numeric) ? numeric : 0).toFixed(2);
}

function limitText(value: string, max: number) {
  return value.length > max ? value.slice(0, max) : value;
}

function requiredTinySetting(key: string, value: string | undefined) {
  if (!value) {
    throw new Error(`Configuracao obrigatoria ausente: ${key}. Preencha em Configuracoes > Tiny.`);
  }

  return value;
}

function settingToString(value: unknown) {
  if (value === null || value === undefined) {
    return "";
  }

  return typeof value === "string" ? value : String(value);
}
