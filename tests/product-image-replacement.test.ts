import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import sharp from "sharp";
import { validatePhotoSequence, signPreparedPhoto, verifyPreparedPhoto } from "../lib/product-photo-edit-policy";
import { processAndStoreDrivePhoto, VPS_IMAGE_ORIGIN } from "../lib/drive-photo-processing";
const old = { id: "old", position: 1, url: "https://res.cloudinary.com/dknfrkqol/image/upload/v1/photo.jpg" };
test("old account permits unchanged images, removal replacement reorder recovery and additions", () => {
  const images = [old, {id:"second",position:2}];
  for (const order of [["existing:old","existing:second"],["existing:second"],["new:x","existing:second"],["remote:0","existing:second"],["existing:second","existing:old"],["existing:old","existing:second","new:x"]]) validatePhotoSequence(order, images);
});
test("unprotected product accepts reorder; rejects duplicate foreign and invalid tokens", () => {
  const images=[{id:"one",position:1},{id:"two",position:2}];
  validatePhotoSequence(["existing:two","existing:one"],images);
  validatePhotoSequence(["new:x","remote:0"],images);
  for(const order of [[],["existing:foreign"],["existing:one","existing:one"],["bad:x"],Array.from({length:7},(_,i)=>"new:"+i)]) assert.throws(()=>validatePhotoSequence(order,images));
});
test("signed receipt binds processed VPS bytes metadata product and user", async () => {
  const writes:Buffer[]=[];
  const buffer=await sharp({create:{width:1600,height:800,channels:3,background:"red"}}).png().toBuffer();
  const photo=await processAndStoreDrivePhoto({buffer,sourceKey:"product-edit:p1",position:2},async(_,bytes)=>{writes.push(bytes)});
  assert.ok(photo.url.startsWith(VPS_IMAGE_ORIGIN));
  assert.equal(photo.bytes,writes[0].length);
  assert.deepEqual([photo.width,photo.height],[1200,600]);
  const signed={...photo,name:"photo.png",productId:"p1",userId:"u1",expiresAt:Date.now()+60000};
  const receipt=signPreparedPhoto(signed,"test-secret");
  assert.deepEqual(verifyPreparedPhoto(receipt,"p1","u1","test-secret"),signed);
  assert.throws(()=>verifyPreparedPhoto(receipt,"p2","u1","test-secret"));
  assert.throws(()=>verifyPreparedPhoto(receipt,"p1","u2","test-secret"));
  assert.throws(()=>verifyPreparedPhoto(receipt,"p1","u1","wrong-secret"));
  const tampered=Buffer.from(JSON.stringify({...signed,url:"https://evil.test/image.jpg"})).toString("base64url")+"."+receipt.split(".")[1];
  assert.throws(()=>verifyPreparedPhoto(tampered,"p1","u1","test-secret"));
  assert.throws(()=>verifyPreparedPhoto(signPreparedPhoto({...signed,expiresAt:Date.now()-1},"test-secret"),"p1","u1","test-secret"));
});
test("VPS writes precede atomic replacement; failures never delete final assets", () => {
  const source=fs.readFileSync(new URL("../app/produtos/actions.ts",import.meta.url),"utf8");
  assert.ok(source.indexOf("await processAndStoreDrivePhoto")<source.indexOf('rpc("replace_product_images_atomically"'));
  assert.doesNotMatch(source,/deleteCloudinaryResource|uploadProductImageToCloudinary/);
  assert.ok(source.includes("readBoundedImage(response, 8 * 1024 * 1024)"));
});
