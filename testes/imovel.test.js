const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const zlib = require("node:zlib");
const AreaGeo = require("../public/area-geo");
const Shapefile = require("../public/shapefile");
const geo = require("../lib/geo");
const { mensagem } = require("../lib/webhook");
const monitor = require("../server");

const KM_LON = 111.32 * Math.cos(13 * Math.PI / 180); // km por grau de longitude a 13°S
const LAT0 = -13, LON0 = -55;
// quadrado de ~2 km x 2 km: oeste-leste de LON0 até LON0 + 2/KM_LON
const quadrado = (x0 = 0, y0 = 0, lado = 2) => [
  [LON0 + x0 / KM_LON, LAT0 + y0 / 111.32], [LON0 + x0 / KM_LON, LAT0 + (y0 + lado) / 111.32],
  [LON0 + (x0 + lado) / KM_LON, LAT0 + (y0 + lado) / 111.32], [LON0 + (x0 + lado) / KM_LON, LAT0 + y0 / 111.32],
  [LON0 + x0 / KM_LON, LAT0 + y0 / 111.32],
];
const imovel = (partes, folga = 5) => {
  const r = AreaGeo.resumirPartes(partes);
  return { id: "im", nome: "Fazenda", lat: r.lat, lon: r.lon, raio: r.raioImovelKm + folga, folga, partes };
};
const foco = (kmLeste, kmNorte, extra = {}) => ({
  lat: LAT0 + kmNorte / 111.32, lon: LON0 + kmLeste / KM_LON, data: new Date().toISOString().slice(0, 10),
  hora: new Date().toISOString().slice(11, 16).replace(":", ""), frp: 10, confianca: "nominal", confirmacoes: 1, satelites: ["VIIRS"], ...extra,
});

test("distância ao imóvel: 0 dentro, distância ao limite fora, ponto de referência no contorno", () => {
  const a = imovel([{ aneis: [quadrado()] }]);
  const dentro = AreaGeo.medirPonto(a, foco(1, 1).lat, foco(1, 1).lon);
  assert.equal(dentro.km, 0); assert.equal(dentro.dentro, true);
  const leste = foco(2 + 3, 1); // 3 km a leste da borda leste
  const m = AreaGeo.medirPonto(a, leste.lat, leste.lon);
  assert.ok(Math.abs(m.km - 3) < 0.02, `km=${m.km}`);
  assert.ok(Math.abs(m.ref.lon - (LON0 + 2 / KM_LON)) < 1e-4); // ponto mais próximo está na borda
  const canto = foco(2 + 3, 2 + 4); // 3-4-5 a partir do canto nordeste
  assert.ok(Math.abs(AreaGeo.medirPonto(a, canto.lat, canto.lon).km - 5) < 0.03);
  const longe = foco(500, 0);
  assert.ok(AreaGeo.medirPonto(a, longe.lat, longe.lon).km > 400);
});

test("buraco no polígono não conta como dentro; partes de feições diferentes formam uma união", () => {
  const comBuraco = imovel([{ aneis: [quadrado(0, 0, 4), quadrado(1, 1, 2)] }]);
  const noBuraco = foco(2, 2);
  const m = AreaGeo.medirPonto(comBuraco, noBuraco.lat, noBuraco.lon);
  assert.equal(m.dentro, false);
  assert.ok(Math.abs(m.km - 1) < 0.02);
  const aneldo = foco(0.5, 0.5);
  assert.equal(AreaGeo.medirPonto(comBuraco, aneldo.lat, aneldo.lon).dentro, true);
  // feições sobrepostas não se anulam (par-ímpar vale só dentro de cada feição)
  const duplicado = imovel([{ aneis: [quadrado()] }, { aneis: [quadrado()] }]);
  assert.equal(AreaGeo.medirPonto(duplicado, foco(1, 1).lat, foco(1, 1).lon).dentro, true);
  assert.ok(Math.abs(AreaGeo.resumirPartes(duplicado.partes).hectares - 400) < 3); // 2 km x 2 km = 400 ha
});

test("analisarArea de imóvel usa a folga: dentro do imóvel e até a folga contam; além, não", () => {
  const a = imovel([{ aneis: [quadrado()] }], 5);
  const an = geo.analisarArea(a, [foco(1, 1), foco(2 + 4, 1), foco(2 + 6, 1)], null);
  assert.equal(an.total, 2);
  assert.equal(an.dentro[0].dentroImovel, true);
  assert.equal(an.nivel, "alto"); // foco dentro do imóvel
  const so = geo.analisarArea(a, [foco(2 + 7, 1)], null);
  assert.equal(so.total, 0);
  // foco a 4 km do limite, com folga 5: dentro da folga, mas além de distAlertaKm (5)?  4 < 5 => Alerta
  assert.equal(geo.analisarArea(a, [foco(2 + 4, 1)], null).nivel, "alto");
  // com folga de 10 km, um foco a 8 km do limite vira Atenção (fora do alerta por proximidade, sem vento)
  const grande = imovel([{ aneis: [quadrado()] }], 10);
  assert.equal(geo.analisarArea(grande, [foco(2 + 8, 1)], null).nivel, "atencao");
});

test("vento a favor mede a direção a partir do limite do imóvel", () => {
  const a = imovel([{ aneis: [quadrado()] }], 20);
  const f = foco(2 + 15, 1); // 15 km a leste da borda; vento VEM do leste (90°) e sopra para o imóvel
  const favor = geo.analisarArea(a, [f], { direcaoDeGraus: 90, velocidadeKmh: 10 });
  assert.equal(favor.nivel, "alto");
  assert.equal(favor.dentro[0].aFavor, true);
  const contra = geo.analisarArea(a, [f], { direcaoDeGraus: 270, velocidadeKmh: 10 });
  assert.equal(contra.nivel, "atencao");
});

test("mensagem do webhook descreve imóvel e folga", () => {
  const a = imovel([{ aneis: [quadrado()] }], 5);
  const texto = mensagem(a, geo.analisarArea(a, [foco(1, 1), foco(2 + 3, 1)], null), null, "Teste");
  assert.match(texto, /no imóvel e a até 5 km dele/);
  assert.match(texto, /dentro do imóvel/);
  assert.match(texto, /3\.0 km do imóvel/);
});

// ---------- shapefile ----------
function montarShp(registros, tipo = 5) {
  const corpos = registros.map((aneis) => {
    const pontos = aneis.flat();
    const b = Buffer.alloc(44 + 4 * aneis.length + 16 * pontos.length);
    b.writeInt32LE(tipo, 0);
    b.writeInt32LE(aneis.length, 36); b.writeInt32LE(pontos.length, 40);
    let i = 0;
    aneis.forEach((anel, k) => { b.writeInt32LE(i, 44 + 4 * k); i += anel.length; });
    pontos.forEach(([x, y], k) => { b.writeDoubleLE(x, 44 + 4 * aneis.length + 16 * k); b.writeDoubleLE(y, 52 + 4 * aneis.length + 16 * k); });
    return b;
  });
  const total = 100 + corpos.reduce((s, c) => s + 8 + c.length, 0);
  const shp = Buffer.alloc(total);
  shp.writeInt32BE(9994, 0); shp.writeInt32BE(total / 2, 24); shp.writeInt32LE(1000, 28); shp.writeInt32LE(tipo, 32);
  let o = 100;
  corpos.forEach((c, n) => { shp.writeInt32BE(n + 1, o); shp.writeInt32BE(c.length / 2, o + 4); c.copy(shp, o + 8); o += 8 + c.length; });
  return shp;
}
const ab = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

test("lê shapefile em graus sem .prj, com aviso, e o resultado serve ao AreaGeo", async () => {
  const shp = montarShp([[quadrado()], [quadrado(), quadrado(0.5, 0.5, 1)]]);
  const r = await Shapefile.carregarShapefile([{ name: "imovel.shp", buffer: ab(shp) }]);
  assert.equal(r.partes.length, 2);
  assert.equal(r.partes[1].aneis.length, 2);
  assert.ok(r.avisos.some((x) => /Sem arquivo \.prj/.test(x)));
  const a = imovel(r.partes);
  assert.equal(AreaGeo.medirPonto(a, foco(1, 1).lat, foco(1, 1).lon).dentro, true);
});

test("rejeita shapefile que não é de polígonos ou não é shapefile", async () => {
  await assert.rejects(Shapefile.carregarShapefile([{ name: "a.shp", buffer: ab(montarShp([[quadrado()]], 3)) }]), /polígonos/);
  await assert.rejects(Shapefile.carregarShapefile([{ name: "a.shp", buffer: new ArrayBuffer(200) }]), /não é um shapefile/);
  await assert.rejects(Shapefile.carregarShapefile([{ name: "a.dbf", buffer: new ArrayBuffer(10) }]), /falta o arquivo \.shp/);
});

test("lê .zip (deflate) com .shp, .prj e .dbf, e usa o nome do .dbf", async () => {
  const shp = montarShp([[quadrado()]]);
  const prj = Buffer.from('GEOGCS["GCS_SIRGAS_2000",DATUM["D_SIRGAS_2000",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]');
  // dbf mínimo: 1 campo NOME_IMOVE (C, 20) e 1 registro
  const dbf = Buffer.alloc(32 + 32 + 1 + 1 + 20);
  dbf.writeUInt32LE(1, 4); dbf.writeUInt16LE(65, 8); dbf.writeUInt16LE(21, 10);
  dbf.write("NOME_IMOVE", 32); dbf.write("C", 43); dbf.writeUInt8(20, 48); dbf.writeUInt8(0x0d, 64);
  dbf.writeUInt8(0x20, 65); dbf.write("Fazenda Boa Vista".padEnd(20), 66, "latin1");
  const itens = [["Area.shp", shp], ["Area.prj", prj], ["Area.dbf", dbf]].map(([nome, dados]) => ({ nome, dados, comp: zlib.deflateRawSync(dados) }));
  const partes = []; const central = []; let desloc = 0;
  for (const it of itens) {
    const nome = Buffer.from(it.nome);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(it.comp.length, 18); local.writeUInt32LE(it.dados.length, 22); local.writeUInt16LE(nome.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(8, 10); c.writeUInt32LE(it.comp.length, 20); c.writeUInt32LE(it.dados.length, 24); c.writeUInt16LE(nome.length, 28); c.writeUInt32LE(desloc, 42);
    partes.push(local, nome, it.comp); central.push(c, nome);
    desloc += 30 + nome.length + it.comp.length;
  }
  const dirCentral = Buffer.concat(central);
  const fim = Buffer.alloc(22); fim.writeUInt32LE(0x06054b50, 0); fim.writeUInt16LE(3, 10); fim.writeUInt32LE(dirCentral.length, 12); fim.writeUInt32LE(desloc, 16);
  const zip = Buffer.concat([...partes, dirCentral, fim]);
  const r = await Shapefile.carregarShapefile([{ name: "imovel.zip", buffer: ab(zip) }]);
  assert.equal(r.partes.length, 1);
  assert.equal(r.nomeSugerido, "Fazenda Boa Vista");
  assert.equal(r.avisos.length, 0); // .prj SIRGAS 2000 reconhecido
});

test("UTM (Transversa de Mercator) do .prj é convertida para graus", async () => {
  const prj = 'PROJCS["SIRGAS_2000_UTM_Zone_21S",GEOGCS["GCS_SIRGAS_2000",DATUM["D_SIRGAS_2000",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",10000000.0],PARAMETER["Central_Meridian",-57.0],PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]';
  const p = Shapefile.lerPrj(prj);
  assert.equal(p.tipo, "tm");
  // meridiano central: x = falso leste => longitude exatamente -57
  const [lon] = Shapefile.tmInversa(p, 500000, 8500000);
  assert.ok(Math.abs(lon + 57) < 1e-9);
  // ida (Snyder, série direta) e volta devem fechar em < 1 mm
  const e2 = 2 * p.f - p.f * p.f, ep2 = e2 / (1 - e2);
  const direta = (lonG, latG) => {
    const fi = latG * Math.PI / 180, dl = (lonG - p.lon0) * Math.PI / 180;
    const N = p.a / Math.sqrt(1 - e2 * Math.sin(fi) ** 2), T = Math.tan(fi) ** 2, C = ep2 * Math.cos(fi) ** 2, A = dl * Math.cos(fi);
    const M = p.a * ((1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * fi - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * Math.sin(2 * fi) + (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * Math.sin(4 * fi) - (35 * e2 ** 3 / 3072) * Math.sin(6 * fi));
    const x = p.fe + p.k0 * N * (A + (1 - T + C) * A ** 3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5 / 120);
    const y = p.fn + p.k0 * (M + N * Math.tan(fi) * (A * A / 2 + (5 - T + 9 * C + 4 * C * C) * A ** 4 / 24 + (61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6 / 720));
    return [x, y];
  };
  for (const [lo, la] of [[-55.94, -13.12], [-56.5, -10.0], [-58.2, -15.5]]) {
    const [x, y] = direta(lo, la);
    const [lo2, la2] = Shapefile.tmInversa(p, x, y);
    assert.ok(Math.abs(lo2 - lo) < 1e-8 && Math.abs(la2 - la) < 1e-8, `${lo},${la} -> ${lo2},${la2}`);
  }
  // ponto conhecido: UTM 21S x=500000 y=8562000 (1.438 km ao sul do equador x 1000) fica na longitude -57 e latitude ≈ -13,0
  assert.ok(Math.abs(Shapefile.tmInversa(p, 500000, 8562000)[1] + 13.0) < 0.05);
  // shapefile projetado sem .prj é recusado
  const shp = montarShp([[[[500000, 8500000], [500000, 8501000], [501000, 8501000], [501000, 8500000], [500000, 8500000]]]]);
  await assert.rejects(Shapefile.carregarShapefile([{ name: "u.shp", buffer: ab(shp) }]), /\.prj/);
  const r = await Shapefile.carregarShapefile([{ name: "u.shp", buffer: ab(shp) }, { name: "u.prj", buffer: ab(Buffer.from(prj)) }]);
  assert.ok(Math.abs(r.partes[0].aneis[0][0][0] + 57) < 1e-6);
});

test("simplifica polígonos com vértices demais sem degenerar", () => {
  const n = 8000;
  const anel = [];
  for (let i = 0; i < n; i++) { const t = (2 * Math.PI * i) / n; anel.push([LON0 + 0.02 * Math.cos(t), LAT0 + 0.02 * Math.sin(t)]); }
  anel.push(anel[0]);
  const r = Shapefile.simplificar([{ aneis: [anel] }], 3000);
  assert.ok(Shapefile.contarVertices(r.partes) <= 3000);
  assert.ok(r.toleranciaM > 0);
  assert.ok(r.partes[0].aneis[0].length >= 4);
});

// ---------- API ----------
test("API: cadastra imóvel por polígono, valida e permite alterar a folga", async (t) => {
  const servidor = monitor.servidor;
  const originalSalvar = monitor.__test.armazenamento.salvarAreas;
  monitor.__test.armazenamento.salvarAreas = () => {};
  monitor.__test.setAreas([]);
  await new Promise((resolve) => servidor.listen(0, "127.0.0.1", resolve));
  const porta = servidor.address().port;
  t.after(() => { servidor.close(); monitor.__test.armazenamento.salvarAreas = originalSalvar; monitor.__test.setAreas([]); });
  const requisicao = (metodo, caminho, corpo) => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: porta, path: caminho, method: metodo, headers: { "Content-Type": "application/json" } }, (res) => {
      let texto = ""; res.setEncoding("utf8"); res.on("data", (p) => { texto += p; });
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(texto) }));
    });
    req.on("error", reject); req.end(corpo === undefined ? undefined : JSON.stringify(corpo));
  });
  const partes = [{ aneis: [quadrado()] }];
  const ok = await requisicao("POST", "/api/areas", { nome: "Fazenda", folga: 4, partes });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.tipo, "imovel"); assert.equal(ok.body.folga, 4);
  assert.ok(ok.body.raio > 4 && ok.body.raio < 8);
  assert.ok(Math.abs(ok.body.hectares - 400) < 5);
  assert.equal((await requisicao("POST", "/api/areas", { nome: "Sem folga informada", partes })).body.folga, 5); // padrão
  assert.equal((await requisicao("POST", "/api/areas", { nome: "x", folga: 51, partes })).status, 400);
  assert.equal((await requisicao("POST", "/api/areas", { nome: "x", folga: -1, partes })).status, 400);
  assert.equal((await requisicao("POST", "/api/areas", { nome: "x", partes: [] })).status, 400);
  assert.equal((await requisicao("POST", "/api/areas", { nome: "x", partes: [{ aneis: [[[1, 2], [3, 4]]] }] })).status, 400);
  assert.equal((await requisicao("POST", "/api/areas", { nome: "x", partes: [{ aneis: [[[NaN, 0], [1, 1], [1, 0], [NaN, 0]]] }] })).status, 400);
  const fora = [{ aneis: [[[-40, -25], [-40, -24.9], [-39.9, -24.9], [-39.9, -25], [-40, -25]]] }];
  assert.equal((await requisicao("POST", "/api/areas", { nome: "Fora", partes: fora })).status, 400);
  assert.equal((await requisicao("POST", "/api/areas", { nome: "", partes })).status, 400);
  const lista = await requisicao("GET", "/api/areas");
  assert.equal(lista.body.filter((a) => a.tipo === "imovel").length, 2);
  const id = ok.body.id;
  const patch = await requisicao("PATCH", `/api/areas/${id}`, { folga: 10, raio: 1 });
  assert.equal(patch.status, 200); assert.equal(patch.body.folga, 10);
  assert.ok(patch.body.raio > 10); // raio ignorado: vem do polígono + folga
  assert.equal((await requisicao("PATCH", `/api/areas/${id}`, { folga: 99 })).status, 400);
});

test("datum SIRGAS 2000 escrito por extenso no .prj não gera aviso", async () => {
  const prj = 'GEOGCS["GCS_SIRGAS_2000",DATUM["Sistema_de_Referencia_Geocentrico_para_America_del_Sur_2000",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';
  const r = await Shapefile.carregarShapefile([{ name: "a.shp", buffer: ab(montarShp([[quadrado()]])) }, { name: "a.prj", buffer: ab(Buffer.from(prj)) }]);
  assert.equal(r.avisos.length, 0);
  const sad = prj.replace("Sistema_de_Referencia_Geocentrico_para_America_del_Sur_2000", "D_South_American_1969");
  const r2 = await Shapefile.carregarShapefile([{ name: "a.shp", buffer: ab(montarShp([[quadrado()]])) }, { name: "a.prj", buffer: ab(Buffer.from(sad)) }]);
  assert.equal(r2.avisos.length, 1);
});
