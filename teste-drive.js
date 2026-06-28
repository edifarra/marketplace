const fs = require("fs");
const crypto = require("crypto");

const SERVICE_ACCOUNT_PATH = "./service-account.json";

// COLE AQUI O ID DA PASTA ROOT
const ROOT_FOLDER_ID = "root";

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
const TOKEN_URI = "https://oauth2.googleapis.com/token";
const DRIVE_API = "https://www.googleapis.com/drive/v3";

function base64Url(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function signJwt(header, payload, privateKey) {
  const encodedHeader = base64Url(JSON.stringify(header));
  const encodedPayload = base64Url(JSON.stringify(payload));
  const input = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto.createSign("RSA-SHA256").update(input).sign(privateKey);
  return `${input}.${base64Url(signature)}`;
}

async function getAccessToken(account) {
  const now = Math.floor(Date.now() / 1000);

  const jwt = signJwt(
    { alg: "RS256", typ: "JWT" },
    {
      iss: account.client_email,
      scope: DRIVE_SCOPE,
      aud: account.token_uri || TOKEN_URI,
      exp: now + 3600,
      iat: now
    },
    account.private_key
  );

  const response = await fetch(account.token_uri || TOKEN_URI, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt
    })
  });

  const json = await response.json();
  if (!response.ok) {
    console.log("ERRO TOKEN:", json);
    process.exit(1);
  }

  return json.access_token;
}

async function driveGet(accessToken, path) {
  const response = await fetch(`${DRIVE_API}${path}`, {
    headers: {
      authorization: `Bearer ${accessToken}`
    }
  });

  const json = await response.json();
  return {
    status: response.status,
    ok: response.ok,
    json
  };
}

async function main() {
  const account = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_PATH, "utf8"));

  console.log("Service Account:");
  console.log(account.client_email);
  console.log("");

  const accessToken = await getAccessToken(account);

  console.log("Token OK");
  console.log("");

  console.log("Testando acesso direto à pasta ROOT...");
  const folder = await driveGet(
    accessToken,
    `/files/${ROOT_FOLDER_ID}?fields=id,name,mimeType,parents,webViewLink&supportsAllDrives=true`
  );

  console.log(JSON.stringify(folder, null, 2));
  console.log("");

  console.log("Listando TODOS os arquivos diretos da ROOT...");
  const params = new URLSearchParams({
    q: `'${ROOT_FOLDER_ID}' trashed = false`,
    fields: "nextPageToken, files(id,name,mimeType,parents,trashed,fileExtension,fullFileExtension,webViewLink,size,md5Checksum)",
    pageSize: "1000",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true"
  });

  const filesResult = await driveGet(accessToken, `/files?${params.toString()}`);

  console.log(JSON.stringify(filesResult, null, 2));

  const files = filesResult.json.files || [];

  console.log("");
  console.log("RESUMO:");
  console.log("Total encontrado:", files.length);

  const alvo = files.find((f) => f.name === "PPSA_TESTEMODELO_TESTECODPLACA_01");

  if (alvo) {
    console.log("ARQUIVO ALVO ENCONTRADO:");
    console.log(JSON.stringify(alvo, null, 2));
  } else {
    console.log("ARQUIVO ALVO NÃO ENCONTRADO.");
  }
}

main().catch((error) => {
  console.error("ERRO GERAL:", error);
});