const test = require("node:test");
const assert = require("node:assert/strict");
const { parsearCsvFirms, nivelConfianca } = require("../lib/firms");

// Implementação anterior (server.js antes da região grande), mantida aqui como referência de comportamento.
function referencia(texto, fonte, bbox) {
  const linhas = texto.trim().split(/\r?\n/);
  if (linhas.length < 2) return [];
  const cab = linhas[0].split(",");
  return linhas.slice(1).map((l) => { const c = l.split(","); const o = {}; cab.forEach((k, i) => (o[k] = c[i])); return o; })
    .map((r) => ({
      lat: parseFloat(r.latitude), lon: parseFloat(r.longitude), data: r.acq_date, hora: (r.acq_time || "").padStart(4, "0"),
      frp: parseFloat(r.frp) || 0, confianca: nivelConfianca(r.confidence), fonte, satelite: "Sat",
    }))
    .filter((f) => Number.isFinite(f.lat) && Number.isFinite(f.lon))
    .filter((f) => f.lon >= bbox.w && f.lon <= bbox.e && f.lat >= bbox.s && f.lat <= bbox.n);
}
const CAB = "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight";
const BBOX = { w: -74, s: -18.1, e: -43.4, n: 5.3 };
const GLOBAL = { w: -180, s: -90, e: 180, n: 90 };

const casos = {
  "VIIRS": [CAB, "-13.1,-55.2,300,1,1,2026-11-08,510,N20,VIIRS,n,2,290,15.5,D", "-12,-54,300,1,1,2026-11-08,1245,N20,VIIRS,h,2,290,80,N"].join("\n"),
  "CRLF e linha final em branco": [CAB, "-13.1,-55.2,300,1,1,2026-11-08,510,N20,VIIRS,l,2,290,15.5,D", "-12,-54,300,1,1,2026-11-08,1245,N20,VIIRS,h,2,290,80,N", ""].join("\r\n"),
  "fora da área e valores inválidos": [CAB, "30,-55,300,1,1,2026-11-08,510,N20,VIIRS,n,2,290,15,D", "abc,-55,300,1,1,2026-11-08,510,N20,VIIRS,n,2,290,15,D", "-13,,300,1,1,2026-11-08,510,N20,VIIRS,n,2,290,15,D", "-13,-55,300,1,1,2026-11-08,510,N20,VIIRS,n,2,290,,D"].join("\n"),
  "linhas em branco": [CAB, "", "-13,-55,300,1,1,2026-11-08,5,N20,VIIRS,n,2,290,,D", "", ""].join("\n"),
  "linha truncada": [CAB, "-13,-55,300,1,1,2026-11-08", "-13,-55"].join("\n"),
  "MODIS (confiança 0-100)": ["latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_t31,frp,daynight", "-13.123,-55.456,330,1,1,2026-11-08,2230,Terra,MODIS,85,6.1NRT,300,45.2,N", "-13.123,-55.456,330,1,1,2026-11-08,2230,Terra,MODIS,10,6.1NRT,300,4,N"].join("\n"),
  "colunas em outra ordem": ["acq_date,frp,longitude,latitude,confidence,acq_time", "2026-11-08,20,-55.5,-13.5,h,1130"].join("\n"),
};

for (const [nome, csv] of Object.entries(casos)) {
  test(`parser da FIRMS é equivalente ao anterior: ${nome}`, () => {
    for (const bbox of [BBOX, GLOBAL]) {
      assert.deepEqual(parsearCsvFirms(csv, { fonte: "F", satelite: "Sat", bbox }), referencia(csv, "F", bbox));
    }
  });
}

test("sem bbox, mantém tudo que tem coordenadas válidas", () => {
  const r = parsearCsvFirms(casos["fora da área e valores inválidos"], { fonte: "F" });
  assert.equal(r.length, 2); // a linha com latitude 30 também fica
  assert.equal(r[0].satelite, "F");
});

test("entrada vazia ou só com cabeçalho", () => {
  assert.deepEqual(parsearCsvFirms("", { fonte: "F" }), []);
  assert.deepEqual(parsearCsvFirms(CAB, { fonte: "F" }), []);
  assert.deepEqual(parsearCsvFirms("nome,valor\n1,2", { fonte: "F" }), []);
});

test("nivelConfianca unifica VIIRS e MODIS", () => {
  assert.equal(nivelConfianca("l"), "baixa");
  assert.equal(nivelConfianca("H"), "alta");
  assert.equal(nivelConfianca("n"), "nominal");
  assert.equal(nivelConfianca("80"), "alta");
  assert.equal(nivelConfianca("30"), "nominal");
  assert.equal(nivelConfianca("29"), "baixa");
  assert.equal(nivelConfianca(undefined), "nominal");
});
