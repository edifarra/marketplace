import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { Server, utils, type SFTPWrapper } from "ssh2";
import { photoDigest, VPS_IMAGE_ORIGIN } from "../lib/drive-photo-processing";
import { storeVpsImage } from "../lib/vps-image-storage";

test("real SSH/SFTP client verifies host, uploads atomically, checks HTTPS and closes on failure", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "pkcs1", format: "pem" } });
  const parsed = utils.parseKey(privateKey);
  if (parsed instanceof Error || Array.isArray(parsed)) throw new Error("test host key invalid");
  const fingerprint = photoDigest(parsed.getPublicSSH());
  const files = new Map<string, Buffer>();
  const directories = new Set<string>();
  let writes = 0;
  const connections = new Set<{ end(): void }>();
  const server = new Server({ hostKeys: [privateKey] }, client => {
    connections.add(client);
    client.on("error", () => {});
    client.on("close", () => connections.delete(client));
    client.on("authentication", context => context.accept());
    client.on("session", accept => accept().on("sftp", acceptSftp => {
      const sftp = acceptSftp() as SFTPWrapper;
      const status = utils.sftp.STATUS_CODE;
      const attributes = (name: string) => ({ mode: directories.has(name) ? 0o40755 : 0o100644,
        size: files.get(name)?.length || 0, uid: 1000, gid: 1000, atime: 0, mtime: 0 });
      sftp.on("MKDIR", (id: number, directory: string) => {
        if (directories.has(directory)) sftp.status(id, status.FAILURE);
        else { directories.add(directory); sftp.status(id, status.OK); }
      });
      sftp.on("LSTAT", (id: number, name: string) => sftp.attrs(id, attributes(name)));
      sftp.on("OPEN", (id: number, name: string, flags: number) => {
        if (flags & utils.sftp.OPEN_MODE.CREAT) {
          if (files.has(name)) return sftp.status(id, status.FAILURE);
          files.set(name, Buffer.alloc(0));
        }
        if (!files.has(name)) return sftp.status(id, status.NO_SUCH_FILE);
        sftp.handle(id, Buffer.from(name));
      });
      sftp.on("FSTAT", (id: number, handle: Buffer) => sftp.attrs(id, attributes(handle.toString())));
      sftp.on("WRITE", (id: number, handle: Buffer, offset: number, data: Buffer) => {
        writes++;
        const name = handle.toString(), previous = files.get(name)!;
        const next = Buffer.alloc(Math.max(previous.length, offset + data.length));
        previous.copy(next); data.copy(next, offset); files.set(name, next); sftp.status(id, status.OK);
      });
      sftp.on("READ", (id: number, handle: Buffer, offset: number, length: number) => {
        const data = files.get(handle.toString())!;
        if (offset >= data.length) sftp.status(id, status.EOF);
        else sftp.data(id, data.subarray(offset, offset + length));
      });
      sftp.on("CLOSE", (id: number) => sftp.status(id, status.OK));
      sftp.on("RENAME", (id: number, from: string, to: string) => {
        if (files.has(to)) return sftp.status(id, status.FAILURE);
        files.set(to, files.get(from)!); files.delete(from); sftp.status(id, status.OK);
      });
      sftp.on("REMOVE", (id: number, name: string) => sftp.status(id, files.delete(name) ? status.OK : status.NO_SUCH_FILE));
    }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server address missing");
  const previous = { ...process.env };
  const previousFetch = globalThis.fetch;
  try {
    Object.assign(process.env, { VPS_IMAGES_SFTP_HOST: "127.0.0.1", VPS_IMAGES_SFTP_PORT: String(address.port),
      VPS_IMAGES_SFTP_USER: "images", VPS_IMAGES_SFTP_KEY_BASE64: Buffer.from(privateKey).toString("base64"),
      VPS_IMAGES_SFTP_ROOT: "/Imagens", VPS_IMAGES_SFTP_HOST_SHA256: fingerprint });
    globalThis.fetch = async url => {
      const file = files.get("/Imagens/" + String(url).replace(VPS_IMAGE_ORIGIN, ""));
      return file ? new Response(new Uint8Array(file), { headers: { "content-type": "image/jpeg" } }) : new Response(null, { status: 404 });
    };
    const bytes = Buffer.from("test-jpeg");
    const name = `produtos/aa/${"a".repeat(64)}/1-${photoDigest(bytes)}.jpg`;
    await storeVpsImage(name, bytes);
    assert.deepEqual([...files.keys()], ["/Imagens/" + name]);
    const beforeRetry = writes;
    await storeVpsImage(name, bytes);
    assert.equal(writes, beforeRetry);

    globalThis.fetch = async () => new Response(null, { status: 404 });
    await assert.rejects(storeVpsImage(name, bytes), /HTTPS/);
    assert.equal(files.size, 1);
    process.env.VPS_IMAGES_SFTP_HOST_SHA256 = "0".repeat(64);
    await assert.rejects(storeVpsImage(name, bytes), /verification failed/i);
    assert.equal(writes, beforeRetry);
    process.env.VPS_IMAGES_SFTP_HOST_SHA256 = fingerprint;
    process.env.VPS_IMAGES_SFTP_KEY_BASE64 = Buffer.from("invalid-key").toString("base64");
    await assert.rejects(storeVpsImage(name, bytes), /privateKey|key/i);
  } finally {
    globalThis.fetch = previousFetch;
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    for (const client of connections) client.end();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
