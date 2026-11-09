const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { Regiao, carregarRegiao } = require("../lib/regiao");

const quadrado = (w, s, e, n) => [[w, s], [e, s], [e, n], [w, n], [w, s]];
const geojsonDe = (...poligonos) => ({
  type: "FeatureCollection", name: "Teste",
  features: poligonos.map((p) => ({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: p } })),
});

test("polígono simples: dentro, fora e fora do retângulo envolvente", () => {
  const r = new Regiao(geojsonDe([quadrado(-60, -15, -50, -5)]));
  assert.equal(r.contem(-10, -55), true);
  assert.equal(r.contem(-20, -55), false);
  assert.equal(r.contem(-10, -45), false);
  assert.equal(r.contem(NaN, -55), false);
  assert.equal(r.contem(undefined, undefined), false);
});

test("buraco no polígono não conta como dentro", () => {
  const r = new Regiao(geojsonDe([quadrado(-60, -15, -50, -5), quadrado(-56, -11, -54, -9).reverse()]));
  assert.equal(r.contem(-10, -55), false, "dentro do buraco");
  assert.equal(r.contem(-6, -52), true);
});

test("polígonos que se sobrepõem formam a união (como o bioma + retângulo do MT)", () => {
  const r = new Regiao(geojsonDe([quadrado(-60, -15, -50, -5)], [quadrado(-55, -20, -45, -10)]));
  assert.equal(r.contem(-18, -47), true, "só no segundo");
  assert.equal(r.contem(-6, -59), true, "só no primeiro");
  assert.equal(r.contem(-12, -52), true, "nos dois");
  assert.equal(r.contem(-4, -47), false);
});

test("MultiPolygon e anel sem repetir o primeiro ponto também funcionam", () => {
  const r = new Regiao({
    type: "Feature", properties: {},
    geometry: { type: "MultiPolygon", coordinates: [[quadrado(-60, -15, -50, -5).slice(0, 4)], [quadrado(-40, -15, -30, -5)]] },
  });
  assert.equal(r.contem(-10, -55), true);
  assert.equal(r.contem(-10, -35), true);
  assert.equal(r.contem(-10, -45), false);
});

test("a grade dá exatamente a mesma resposta que o teste ponto-em-polígono", () => {
  // polígono em estrela, bem irregular, para exercitar células de borda
  const pts = [];
  for (let i = 0; i < 40; i++) {
    const ang = (i / 40) * 2 * Math.PI, raio = i % 2 ? 3 : 8.3;
    pts.push([-55 + raio * Math.cos(ang), -12 + raio * Math.sin(ang) * 0.8]);
  }
  pts.push(pts[0]);
  const r = new Regiao(geojsonDe([pts]), { resolucao: 0.25 });
  let s = 11; const rnd = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
  let dentro = 0;
  for (let i = 0; i < 40000; i++) {
    const lat = -22 + rnd() * 20, lon = -66 + rnd() * 22;
    const esperado = r.contemExato(lat, lon);
    assert.equal(r.contem(lat, lon), esperado, `${lat},${lon}`);
    if (esperado) dentro++;
  }
  assert.ok(dentro > 1000 && dentro < 39000, "o teste precisa ter pontos dos dois lados");
});

test("bbox é arredondado para fora em 0,01°", () => {
  const r = new Regiao(geojsonDe([quadrado(-60.004, -15.006, -50.001, -5.0001)]));
  assert.deepEqual(r.bbox, { w: -60.01, s: -15.01, e: -50, n: -5 });
});

test("GeoJSON sem polígono é rejeitado", () => {
  assert.throws(() => new Regiao({ type: "FeatureCollection", features: [] }), /nenhum polígono/);
});

test("região entregue com o projeto: cidades conhecidas dentro e fora", () => {
  const r = carregarRegiao(path.join(__dirname, "..", "assets", "regiao.geojson"));
  const dentro = { Sinop: [-11.86, -55.5], Manaus: [-3.12, -60.02], Belém: [-1.46, -48.5], "Porto Velho": [-8.76, -63.9], Cuiabá: [-15.6, -56.1], "Rio Branco": [-9.97, -67.81], "Boa Vista": [2.82, -60.67] };
  const fora = { "São Paulo": [-23.55, -46.63], Brasília: [-15.8, -47.9], "Santa Cruz (BO)": [-17.8, -63.2], Lima: [-12.05, -77.04], "Buenos Aires": [-34.6, -58.4] };
  for (const [n, [la, lo]] of Object.entries(dentro)) assert.equal(r.contem(la, lo), true, n);
  for (const [n, [la, lo]] of Object.entries(fora)) assert.equal(r.contem(la, lo), false, n);
  assert.ok(r.nome);
});
