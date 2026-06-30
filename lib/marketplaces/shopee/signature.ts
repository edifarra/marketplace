import crypto from "crypto";

type ShopeeSignatureInput = {
  partnerId: string | number;
  partnerKey: string;
  path: string;
  timestamp: number;
  accessToken?: string | null;
  shopId?: string | number | null;
};

export function createShopeeSignature({
  partnerId,
  partnerKey,
  path,
  timestamp,
  accessToken,
  shopId
}: ShopeeSignatureInput) {
  const baseString = accessToken && shopId
    ? `${partnerId}${path}${timestamp}${accessToken}${shopId}`
    : `${partnerId}${path}${timestamp}`;

  return crypto.createHmac("sha256", partnerKey).update(baseString).digest("hex");
}
