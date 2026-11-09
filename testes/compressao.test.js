const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const { codificacaoPreferida, CorpoComprimivel, enviarCorpo } = require("../lib/compressao");

test("negociação de codificação respeita preferência e q=0", () => {
  assert.equal(codificacaoPreferida(undefined), null);
  assert.equal(codificacaoPreferida(""), null);
  assert.equal(codificacaoPreferida("gzip, deflate"), "gzip");
  assert.equal(codificacaoPreferida("gzip, deflate, br"), "br");
  assert.equal(codificacaoPreferida("br;q=0, gzip"), "gzip");
  assert.equal(codificacaoPreferida("gzip;q=0.5, br;q=0.9"), "br");
  assert.equal(codificacaoPreferida("br;q=0.2, gzip;q=0.9"), "gzip");
  assert.equal(codificacaoPreferida("identity"), null);
  assert.equal(codificacaoPreferida("*"), "br");
  assert.equal(codificacaoPreferida("gzip;q=0, br;q=0"), null);
});

test("CorpoComprimivel comprime uma vez por codificação e preserva o conteúdo", async () => {
  const original = Buffer.from(JSON.stringify({ focos: Array.from({ length: 500 }, (_, i) => ({ lat: -10 - i / 1000, lon: -55 })) }));
  const corpo = new CorpoComprimivel(original, "application/json");
  const a = corpo.obter("gzip"), b = corpo.obter("gzip");
  assert.strictEqual(a, b, "a mesma promessa: não comprime duas vezes");
  assert.deepEqual(zlib.gunzipSync(await a), original);
  assert.deepEqual(zlib.brotliDecompressSync(await corpo.obter("br")), original);
  assert.deepEqual(await corpo.obter(null), original);
  assert.match(corpo.etag, /^W\/"/);
});

test("corpo pequeno não é comprimido", async () => {
  const corpo = new CorpoComprimivel(Buffer.from("{}"), "application/json");
  assert.deepEqual(await corpo.obter("gzip"), Buffer.from("{}"));
});

function resFalso() {
  const r = { cabecalhos: null, status: null, corpo: undefined, writeHead(s, h) { this.status = s; this.cabecalhos = h; }, end(c) { this.corpo = c; } };
  return r;
}

test("enviarCorpo: HEAD não manda corpo e If-None-Match devolve 304", async () => {
  const corpo = new CorpoComprimivel(Buffer.alloc(4000, "a"), "text/plain");
  const head = resFalso();
  await enviarCorpo({ method: "HEAD", headers: { "accept-encoding": "gzip" } }, head, corpo);
  assert.equal(head.status, 200);
  assert.equal(head.corpo, undefined);
  assert.equal(head.cabecalhos["Content-Encoding"], "gzip");
  const nm = resFalso();
  await enviarCorpo({ method: "GET", headers: { "if-none-match": corpo.etag, "accept-encoding": "gzip" } }, nm, corpo);
  assert.equal(nm.status, 304);
  const outro = resFalso();
  await enviarCorpo({ method: "GET", headers: { "if-none-match": 'W/"outro"' } }, outro, corpo);
  assert.equal(outro.status, 200);
  assert.equal(outro.cabecalhos["Content-Encoding"], undefined);
});
