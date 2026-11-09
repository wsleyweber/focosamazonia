const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const inpe = require("../lib/inpe");
const monitor = require("../server");
const geo = require("../lib/geo");
const { criarObservador } = require("../lib/observacao-geo");

const BBOX = { w: -61.7, s: -18.1, e: -50.2, n: -7.3 };
const amostras = path.join(__dirname, "amostras");

test("amostra INPE 20261107_0320 lê 53 linhas e filtra focos dentro do BBOX", () => {
  const texto = fs.readFileSync(path.join(amostras, "focos_10min_20261107_0320.csv"), "utf8");
  const focos = inpe.parsearCsv(texto);
  assert.equal(focos.length, 53);
  assert.equal(inpe.filtrarBbox(focos, BBOX).length, 8);
  assert.equal(focos[0].lat, 5.4002);
  assert.equal(focos[0].lon, -53.0533);
  assert.equal(focos[0].data, "2026-11-07");
  assert.equal(focos[0].hora, "0300");
  assert.equal(focos[0].varredurasGeo[0], "2026-11-07T03:00:00Z");
  assert.equal(focos[0].frp, 0);
  assert.equal(focos[0].confianca, "nominal");
});

test("amostra INPE 20261106_1600 confirma volume, BBOX e horário da varredura", () => {
  const texto = fs.readFileSync(path.join(amostras, "focos_10min_20261106_1600.csv"), "utf8");
  const focos = inpe.parsearCsv(texto);
  assert.equal(focos.length, 165);
  assert.equal(inpe.filtrarBbox(focos, BBOX).length, 0);
  assert.equal(focos[0].data, "2026-11-06");
  assert.equal(focos[0].hora, "1540");
});

test("listagem do INPE seleciona só arquivos recentes e falha claramente sem nomes reconhecidos", () => {
  const agora = Date.parse("2026-11-07T03:30:00Z");
  const html = [
    '<a href="focos_10min_20261107_0320.csv">latest</a>',
    '<a href="focos_10min_20261107_0200.csv">old</a>',
    '<a href="focos_10min_20261107_0400.csv">future</a>',
  ].join("\n");
  assert.deepEqual(inpe.selecionarArquivos(html, 1, agora), ["focos_10min_20261107_0320.csv"]);
  assert.throws(() => inpe.selecionarArquivos("<html>mudou</html>", 1, agora), /listagem do INPE/);
});

test("foco só geo exige varreduras distintas, não confirma por si e usa tolerância própria", () => {
  const ponto = { lat: -13.1, lon: -55.1 };
  const geoRaw = [
    { ...ponto, data: "2026-11-07", hora: "0300", satelite: "GOES-19", frp: 0, confianca: "nominal", varredurasGeo: ["2026-11-07T03:00Z"] },
    { ...ponto, data: "2026-11-07", hora: "0310", satelite: "GOES-19", frp: 0, confianca: "nominal", varredurasGeo: ["2026-11-07T03:10Z"] },
    { ...ponto, data: "2026-11-07", hora: "0310", satelite: "GOES-19", frp: 0, confianca: "nominal", varredurasGeo: ["2026-11-07T03:10Z"] },
  ];
  const [focoGeo] = monitor.mesclar([geoRaw]);
  assert.equal(focoGeo.somenteGeo, true);
  assert.equal(focoGeo.deteccoesGeo, 2);
  assert.equal(focoGeo.confirmacoes, 0);

  const area = { ...ponto, raio: 20 };
  assert.equal(geo.analisarArea(area, [focoGeo], null).nivel, "atencao");
  assert.equal(geo.analisarArea(area, [focoGeo], null, { ...geo.CONFIG_PADRAO, geoPodeAlertar: true }).nivel, "alto");

  const polar = { ...ponto, lon: ponto.lon + 3 / 108, data: "2026-11-07", hora: "0400", satelites: ["VIIRS NOAA-20"], frp: 17, confianca: "alta" };
  const [confirmado] = monitor.mesclar([[focoGeo], [polar]]);
  assert.equal(confirmado.somenteGeo, false);
  assert.equal(confirmado.confirmacoes, 1);
  assert.equal(confirmado.frp, 17);
});

test("observador guarda confirmação polar e calcula tempo até confirmação", (t) => {
  const pasta = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "fogo-mt-observacao-"));
  t.after(() => fs.rmSync(pasta, { recursive: true, force: true }));
  const arquivo = path.join(pasta, "observacao-geo.jsonl");
  const observador = criarObservador(arquivo, 4, geo.distanciaKm);
  const focoGeo = {
    lat: -13, lon: -55, somenteGeo: true,
    data: "2026-11-07", hora: "0300",
  };
  observador.atualizar([focoGeo], [], Date.parse("2026-11-07T03:20:00Z"));
  const polar = {
    lat: -13, lon: -55, data: "2026-11-07", hora: "0400",
    satelites: ["VIIRS NOAA-20"],
  };
  const resultado = observador.atualizar([focoGeo], [polar], Date.parse("2026-11-07T04:10:00Z"));
  assert.equal(resultado.resumo.confirmados, 1);
  assert.equal(resultado.resumo.medianaMinutos, 60);
  const registros = fs.readFileSync(arquivo, "utf8").trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(registros.length, 2);
  assert.equal(registros[0].primeiraVarredura, "2026-11-07T03:00:00Z");
});
