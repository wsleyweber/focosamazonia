const test = require("node:test");
const assert = require("node:assert/strict");
const geo = require("../lib/geo");

const area = { lat: -13, lon: -55, raio: 200 };
const focoLeste = (km, idadeHoras = 0) => {
  const instante = new Date(Date.now() - idadeHoras * 60 * 60 * 1000);
  return {
    lat: area.lat,
    lon: area.lon + km / 108,
    data: instante.toISOString().slice(0, 10),
    hora: instante.toISOString().slice(11, 16).replace(":", ""),
    frp: 12.3,
    confianca: "nominal",
    confirmacoes: 1,
    satelites: ["VIIRS NOAA-20"],
  };
};

test("regra de níveis: proximidade e vento limitado por distância", () => {
  assert.equal(geo.analisarArea(area, [focoLeste(3)], null).nivel, "alto");
  assert.equal(geo.analisarArea(area, [focoLeste(40)], null).nivel, "atencao");
  assert.equal(geo.analisarArea(area, [focoLeste(20)], { direcaoDeGraus: 90, velocidadeKmh: 10 }).nivel, "alto");
  assert.equal(geo.analisarArea(area, [focoLeste(20)], { direcaoDeGraus: 270, velocidadeKmh: 10 }).nivel, "atencao");
  assert.equal(geo.analisarArea(area, [focoLeste(120)], null).nivel, "atencao");
});

test("vento nulo ou fraco não causa Alerta por vento", () => {
  assert.equal(geo.analisarArea(area, [focoLeste(20)], null).nivel, "atencao");
  assert.equal(geo.analisarArea(area, [focoLeste(20)], { direcaoDeGraus: NaN, velocidadeKmh: 50 }).nivel, "atencao");
  assert.equal(geo.analisarArea(area, [focoLeste(20)], { direcaoDeGraus: 90, velocidadeKmh: 2 }, {
    ...geo.CONFIG_PADRAO, ventoMinKmh: 5,
  }).nivel, "atencao");
  assert.equal(geo.analisarArea(area, [focoLeste(20)], { direcaoDeGraus: 90, velocidadeKmh: 10 }, {
    ...geo.CONFIG_PADRAO, ventoMinKmh: 5,
  }).nivel, "alto");
  assert.equal(geo.analisarArea(area, [focoLeste(3)], { direcaoDeGraus: 90, velocidadeKmh: 2 }, {
    ...geo.CONFIG_PADRAO, ventoMinKmh: 5,
  }).nivel, "alto");
});

test("foco mais velho que IDADE_MAX_VENTO_H não causa Alerta por vento", () => {
  const focoAntigo = focoLeste(20, geo.CONFIG_PADRAO.idadeMaxVentoH + 1);
  const resultado = geo.analisarArea(area, [focoAntigo], { direcaoDeGraus: 90, velocidadeKmh: 10 });
  assert.equal(resultado.nivel, "atencao");
  assert.equal(resultado.maisProximo.aFavor, false);

  const focoProximoAntigo = focoLeste(3, geo.CONFIG_PADRAO.idadeMaxVentoH + 1);
  assert.equal(geo.analisarArea(area, [focoProximoAntigo], { direcaoDeGraus: 90, velocidadeKmh: 10 }).nivel, "alto");
});

test("análise fornece direção, motivos e idade legível", () => {
  const resultado = geo.analisarArea(area, [focoLeste(3)], null);
  assert.ok(Math.abs(resultado.maisProximo.rumo - 90) < 0.01);
  assert.equal(geo.nomePonto(resultado.maisProximo.rumo), "Leste (L)");
  assert.equal(geo.nomePonto(315), "Noroeste (NO)");
  assert.deepEqual(resultado.motivos, ["proximidade"]);
  assert.equal(geo.idadeMinutos({ data: "2026-11-06", hora: "1200" }, Date.parse("2026-11-06T12:25:00Z")), 25);
  assert.equal(geo.formatarIdade(25), "há 25 min");
  assert.equal(geo.formatarIdade(190), "há 3 h 10 min");
  assert.equal(geo.formatarIdade(1441), "há mais de 24 h");
});
