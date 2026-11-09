const test = require("node:test");
const assert = require("node:assert/strict");
const { regraParaZoom, selecionarFocosVisiveis, MAX_NO_MAPA } = require("../public/regras-zoom");

const foco = (lat, lon, frp, confirmacoes = 1, extra = {}) => ({ lat, lon, frp, confirmacoes, somenteGeo: false, ...extra });

const fraco = foco(-10, -55, 3);
const medio = foco(-10.1, -55, 25);
const forte = foco(-10.2, -55, 80);
const confirmadoFraco = foco(-10.3, -55, 2, 2);
const geoSo = foco(-10.4, -55, 0, 0, { somenteGeo: true });
const todos = [fraco, medio, forte, confirmadoFraco, geoSo];

test("afastado: só confirmados ou potência alta", () => {
  const r = selecionarFocosVisiveis(todos, { zoom: 5 });
  assert.deepEqual(new Set(r.visiveis), new Set([forte, confirmadoFraco]));
  assert.equal(r.ocultosPorZoom, 3);
  assert.equal(r.regra.id, "afastado");
});

test("intermediário: confirmados ou potência média e alta", () => {
  const r = selecionarFocosVisiveis(todos, { zoom: 7 });
  assert.deepEqual(new Set(r.visiveis), new Set([medio, forte, confirmadoFraco]));
  assert.equal(r.regra.id, "intermediario");
});

test("próximo: todos os focos", () => {
  const r = selecionarFocosVisiveis(todos, { zoom: 9 });
  assert.equal(r.visiveis.length, 5);
  assert.equal(r.ocultosPorZoom, 0);
});

test("os limites de zoom da regra são os documentados (6, 8 e acima)", () => {
  assert.equal(regraParaZoom(4).id, "afastado");
  assert.equal(regraParaZoom(6).id, "afastado");
  assert.equal(regraParaZoom(7).id, "intermediario");
  assert.equal(regraParaZoom(8).id, "intermediario");
  assert.equal(regraParaZoom(9).id, "proximo");
  assert.equal(regraParaZoom(18).id, "proximo");
});

test("a regra não altera nem remove focos da lista original (a análise das áreas usa a lista completa)", () => {
  const copia = todos.slice();
  selecionarFocosVisiveis(todos, { zoom: 4 });
  assert.deepEqual(todos, copia);
  assert.equal(todos.length, 5);
});

test("só desenha o que está na área visível; contagens também só consideram a tela", () => {
  const longe = foco(-3, -60, 3);
  const r = selecionarFocosVisiveis([fraco, longe], { zoom: 9, limites: { w: -56, s: -11, e: -54, n: -9 } });
  assert.deepEqual(r.visiveis, [fraco]);
  const r2 = selecionarFocosVisiveis([fraco, longe], { zoom: 5, limites: { w: -61, s: -4, e: -59, n: -2 } });
  assert.equal(r2.ocultosPorZoom, 1);
});

test("foco destacado aparece mesmo que a regra o esconda", () => {
  const r = selecionarFocosVisiveis(todos, { zoom: 4, destacado: fraco });
  assert.ok(r.visiveis.includes(fraco));
});

test("teto de marcadores: ficam os confirmados e de maior potência; destacado é preservado", () => {
  const muitos = Array.from({ length: 50 }, (_, i) => foco(-10 - i * 0.01, -55, i + 1));
  const conf = foco(-12, -55, 1, 3);
  const r = selecionarFocosVisiveis(muitos.concat([conf]), { zoom: 12, maximo: 10, destacado: muitos[0] });
  assert.equal(r.visiveis.length, 10);
  assert.ok(r.visiveis.includes(conf));
  assert.ok(r.visiveis.includes(muitos[0]), "destacado fica mesmo sendo o de menor potência");
  assert.ok(r.visiveis.includes(muitos[49]));
  assert.equal(r.ocultosPorTeto, 41);
  assert.equal(MAX_NO_MAPA, 3000);
});

test("o teto padrão acompanha a regra: menor no zoom afastado", () => {
  const muitos = Array.from({ length: 4000 }, (_, i) => foco(-10 - i * 0.001, -55, 60 + (i % 10))); // todos de potência alta
  const longe = selecionarFocosVisiveis(muitos, { zoom: 5 });
  const meio = selecionarFocosVisiveis(muitos, { zoom: 7 });
  const perto = selecionarFocosVisiveis(muitos, { zoom: 11 });
  assert.equal(longe.visiveis.length, 1500);
  assert.equal(longe.ocultosPorTeto, 2500);
  assert.equal(meio.visiveis.length, 3000);
  assert.equal(perto.visiveis.length, 3000);
  assert.ok(longe.visiveis.every((f) => f.frp >= 60) && longe.visiveis[0].frp >= longe.visiveis[1499].frp - 10);
});
