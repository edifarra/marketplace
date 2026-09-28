import assert from "node:assert/strict";
import test from "node:test";
import { compareMercadoLivrePictures, hasProcessingMercadoLivrePictures, requestedMercadoLivrePictureSources } from "../lib/mercado-livre-picture-confirmation";

const sources = ["https://cdn.example/1.jpg", "https://cdn.example/2.jpg", "https://cdn.example/3.jpg", "https://cdn.example/4.jpg"];

test("extracts requested picture sources in payload order", () => {
  assert.deepEqual(requestedMercadoLivrePictureSources({ pictures: sources.map((source) => ({ source })) }), sources);
});

test("confirms pictures only when the final GET contains every returned picture", () => {
  const pictures = sources.map((_, index) => ({ id: `PIC-${index + 1}`, secure_url: `https://ml/PIC-${index + 1}.jpg` }));
  const result = compareMercadoLivrePictures(sources, pictures, pictures);
  assert.equal(result.matches, true);
  assert.equal(result.expectedCount, 4);
  assert.equal(result.finalCount, 4);
  assert.deepEqual(result.missingPositions, []);
});

test("reports missing positions when Mercado Livre keeps only one picture", () => {
  const updatePictures = sources.map((_, index) => ({ id: `PIC-${index + 1}` }));
  const result = compareMercadoLivrePictures(sources, updatePictures, [{ id: "PIC-1" }]);
  assert.equal(result.matches, false);
  assert.deepEqual(result.missingPositions.map((picture) => picture.position), [2, 3, 4]);
});

test("reports missing positions when the update response itself has only three pictures", () => {
  const updatePictures = sources.slice(0, 3).map((_, index) => ({ id: `PIC-${index + 1}` }));
  const result = compareMercadoLivrePictures(sources, updatePictures, updatePictures);
  assert.equal(result.matches, false);
  assert.equal(result.updateCount, 3);
  assert.equal(result.finalCount, 3);
  assert.deepEqual(result.missingPositions, [{ position: 4, source: sources[3] }]);
});

test("recognizes Mercado Livre asynchronous processing placeholders", () => {
  assert.equal(hasProcessingMercadoLivrePictures([{ secure_url: "https://http2.mlstatic.com/resources/frontend/statics/processing-image/1.0.0/O-PT.jpg" }]), true);
  assert.equal(hasProcessingMercadoLivrePictures([{ id: "PIC-1", status: "processing" }]), true);
  assert.equal(hasProcessingMercadoLivrePictures([{ id: "PIC-1", secure_url: "https://http2.mlstatic.com/PIC-1-O.jpg" }]), false);
});
