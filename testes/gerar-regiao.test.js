const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const g = require("../scripts/gerar-regiao");
const { Regiao } = require("../lib/regiao");

// ---- escritor mínimo de shapefile/dbf, só para os testes
function registroPoligono(aneis) {
  const pontos = aneis.flat();
  const tam = 44 + 4 * aneis.length + 16 * pontos.length;
  const b = Buffer.alloc(8 + tam);
  b.writeInt32BE(1, 0); b.writeInt32BE(tam / 2, 4);
  b.writeInt32LE(5, 8);
  const xs = pontos.map((p) => p[0]), ys = pontos.map((p) => p[1]);
  [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].forEach((v, i) => b.writeDoubleLE(v, 12 + 8 * i));
  b.writeInt32LE(aneis.length, 44); b.writeInt32LE(pontos.length, 48);
  let inicio = 0;
  aneis.forEach((a, i) => { b.writeInt32LE(inicio, 52 + 4 * i); inicio += a.length; });
  const base = 52 + 4 * aneis.length;
  pontos.forEach((p, i) => { b.writeDoubleLE(p[0], base + 16 * i); b.writeDoubleLE(p[1], base + 16 * i + 8); });
  return b;
}
function escreverShapefile(dir, nome, formas, atributos) {
  const registros = formas.map((aneis, i) => { const r = registroPoligono(aneis); r.writeInt32BE(i + 1, 0); return r; });
  const cab = Buffer.alloc(100);
  cab.writeInt32BE(9994, 0);
  cab.writeInt32BE((100 + registros.reduce((t, r) => t + r.length, 0)) / 2, 24);
  cab.writeInt32LE(1000, 28); cab.writeInt32LE(5, 32);
  fs.writeFileSync(path.join(dir, nome + ".shp"), Buffer.concat([cab, ...registros]));
  const tamCampo = 20, tamReg = 1 + tamCampo;
  const dbf = Buffer.alloc(32 + 32 + 1 + tamReg * atributos.length);
  dbf[0] = 3; dbf.writeUInt32LE(atributos.length, 4); dbf.writeUInt16LE(65, 8); dbf.writeUInt16LE(tamReg, 10);
  dbf.write("Bioma", 32, "latin1"); dbf[32 + 11] = 67; dbf[32 + 16] = tamCampo;
  dbf[64] = 0x0d;
  atributos.forEach((a, i) => { dbf[65 + i * tamReg] = 0x20; dbf.write(a.padEnd(tamCampo), 65 + i * tamReg + 1, "utf8"); });
  fs.writeFileSync(path.join(dir, nome + ".dbf"), dbf);
  fs.writeFileSync(path.join(dir, nome + ".cpg"), "UTF-8");
}
// shapefile: externo horário, buraco anti-horário
const horario = (w, s, e, n) => [[w, s], [w, n], [e, n], [e, s], [w, s]];
const antiHorario = (w, s, e, n) => horario(w, s, e, n).reverse();

function montarCenario() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "regiao-"));
  escreverShapefile(dir, "biomas", [
    [horario(-60, -15, -50, -5), antiHorario(-56, -11, -54, -9), horario(-45, -3, -44.99, -2.99)], // "Amazônia": com buraco e uma ilhota de ~1 km²
    [horario(-50, -25, -40, -15)],                                                           // "Cerrado"
    [horario(-70, 0, -65, 4)],                                                               // "Pantanal" (só para ter 3 registros)
  ], ["Amazônia", "Cerrado", "Pantanal"]);
  return path.join(dir, "biomas.shp");
}

test("lê shapefile e dbf (acentos em UTF-8)", () => {
  const shp = montarCenario();
  const formas = g.lerShp(shp);
  assert.equal(formas.length, 3);
  assert.equal(formas[0].length, 3);
  assert.deepEqual(formas[0][0][0], [-60, -15]);
  assert.deepEqual(g.lerDbf(shp.replace(/\.shp$/, ".dbf")).map((r) => r.Bioma), ["Amazônia", "Cerrado", "Pantanal"]);
});

test("filtra por atributo ignorando acento e caixa, monta buraco e descarta ilhota", () => {
  const shp = montarCenario();
  const { geojson } = g.gerarRegiao({ camadas: [`${shp}:Bioma=amazonia`], areaMinKm2: 5 });
  assert.equal(geojson.features.length, 1);
  const poligonos = geojson.features[0].geometry.coordinates;
  assert.equal(poligonos.length, 1, "a ilhota de ~1 km², abaixo do mínimo de 5 km², some");
  assert.equal(poligonos[0].length, 2, "externo + 1 buraco");
  const r = new Regiao(geojson);
  assert.equal(r.contem(-7, -58), true);
  assert.equal(r.contem(-10, -55), false, "buraco");
  assert.equal(r.contem(-20, -45), false, "Cerrado ficou de fora");
  assert.deepEqual(r.bbox, { w: -60, s: -15, e: -50, n: -5 });
});

test("ilhota acima do mínimo é mantida", () => {
  const shp = montarCenario();
  const { geojson } = g.gerarRegiao({ camadas: [`${shp}:Bioma=Amazônia`], areaMinKm2: 0.1 });
  assert.equal(geojson.features[0].geometry.coordinates.length, 2);
});

test("orientação RFC 7946: externo anti-horário, buraco horário", () => {
  const shp = montarCenario();
  const [poligono] = g.gerarRegiao({ camadas: [`${shp}:Bioma=Amazônia`] }).geojson.features[0].geometry.coordinates;
  assert.ok(g.areaAssinada(poligono[0]) > 0);
  assert.ok(g.areaAssinada(poligono[1]) < 0);
  assert.deepEqual(poligono[0][0], poligono[0][poligono[0].length - 1], "anel fechado");
});

test("várias camadas e retângulo viram partes da mesma região", () => {
  const shp = montarCenario();
  const { geojson, resumo } = g.gerarRegiao({
    camadas: [`${shp}:Bioma=Amazônia`, `${shp}:Bioma=Pantanal`], retangulos: [[-50, -25, -40, -15]], nome: "Junto",
  });
  assert.equal(geojson.name, "Junto");
  assert.equal(geojson.features.length, 3);
  assert.equal(resumo.length, 3);
  const r = new Regiao(geojson);
  assert.equal(r.contem(2, -67), true); // lat 2, lon -67 (Pantanal do cenário)
  assert.equal(r.contem(-20, -45), true);
  assert.deepEqual(geojson.bbox, [-70, -25, -40, 4]);
});

test("simplificação respeita a tolerância e mantém o formato", () => {
  // zigue-zague de 0,001° de amplitude ao longo de uma linha reta
  const linha = Array.from({ length: 1001 }, (_, i) => [i * 0.01, (i % 2) * 0.001]);
  const simples = g.simplificarLinha(linha, 0.005);
  assert.ok(simples.length <= 3, `esperava poucos pontos, veio ${simples.length}`);
  assert.deepEqual(simples[0], linha[0]);
  assert.deepEqual(simples[simples.length - 1], linha[linha.length - 1]);
  const intacto = g.simplificarLinha(linha, 0);
  assert.equal(intacto.length, linha.length);
  // anel pequeno demais some
  assert.deepEqual(g.simplificarAnel([[0, 0], [1, 0], [0, 0]], 0.1), []);
});

test("mensagens de erro úteis", () => {
  const shp = montarCenario();
  assert.throws(() => g.gerarRegiao({ camadas: [`${shp}:Bioma=Caatinga`] }), /nenhum registro com Bioma=Caatinga.*Amazônia, Cerrado, Pantanal/);
  assert.throws(() => g.gerarRegiao({ camadas: [`${shp}:Nome=x`] }), /campo Nome não existe.*Bioma/);
  assert.throws(() => g.gerarRegiao({}), /ao menos uma/);
  assert.throws(() => g.lerShp(shp.replace(/\.shp$/, ".dbf")), /não é um shapefile/);
  assert.throws(() => g.lerArgumentos(["--retangulo", "1,2,3"]), /w,s,e,n/);
  assert.throws(() => g.lerArgumentos(["--foo", "x"]), /desconhecida/);
});

test("o arquivo de região entregue com o projeto é um GeoJSON válido e pequeno", () => {
  const arquivo = path.join(__dirname, "..", "assets", "regiao.geojson");
  const tamanho = fs.statSync(arquivo).size;
  assert.ok(tamanho < 400 * 1024, `regiao.geojson com ${tamanho} bytes: reduza a precisão ou aumente a tolerância`);
  const geojson = JSON.parse(fs.readFileSync(arquivo, "utf8"));
  assert.equal(geojson.type, "FeatureCollection");
  assert.ok(geojson.features.length >= 1);
});
