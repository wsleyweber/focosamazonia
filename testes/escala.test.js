// Testes da resposta de /api/focos para a região grande: compressão, ETag, recorte pela região, teto,
// deduplicação de downloads, timeout e cache parcial. Nunca chama a FIRMS real: fetch é simulado.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const zlib = require("node:zlib");
const monitor = require("../server");

const CABECALHO = "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight";

function csv(pontos) {
  const agora = new Date().toISOString();
  const data = agora.slice(0, 10), hora = agora.slice(11, 16).replace(":", "");
  const linhas = [CABECALHO];
  for (const p of pontos) linhas.push(`${p.lat},${p.lon},300,1,1,${data},${hora},N20,VIIRS,${p.conf || "n"},2,290,${p.frp ?? 15},D`);
  return linhas.join("\n");
}
const resposta = (texto) => ({ ok: true, status: 200, async text() { return texto; }, async json() { return {}; } });

// Pontos de referência (coordenadas aproximadas, longe de bordas)
const SINOP = { lat: -11.86, lon: -55.5 };        // dentro (bioma Amazônia)
const MANAUS = { lat: -3.12, lon: -60.02 };       // dentro
const CUIABA = { lat: -15.6, lon: -56.1 };        // dentro (retângulo do MT; é Cerrado)
const SANTA_CRUZ = { lat: -17.8, lon: -63.2 };    // Bolívia: dentro do BBOX, fora da região
const CAMPO_GRANDE = { lat: -20.4, lon: -54.6 };  // fora do BBOX (ao sul)

function prepararServidor(t, { fetchFalso, areas = [] } = {}) {
  const originalFetch = global.fetch;
  const originalError = console.error;
  console.error = () => {};
  monitor.__test.setAreas(areas);
  monitor.__test.setModoInpe("off");
  monitor.__test.limparCache();
  global.fetch = fetchFalso;
  return new Promise((resolve) => {
    monitor.servidor.listen(0, "127.0.0.1", () => {
      const porta = monitor.servidor.address().port;
      t.after(() => {
        monitor.servidor.close();
        global.fetch = originalFetch;
        console.error = originalError;
        monitor.__test.setAreas([]);
        monitor.__test.setTimeoutFirmsMs(90_000);
        monitor.__test.limparCache();
      });
      resolve(porta);
    });
  });
}

function pegar(porta, caminho, cabecalhos = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: porta, path: caminho, headers: cabecalhos }, (res) => {
      const partes = [];
      res.on("data", (c) => partes.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, corpo: Buffer.concat(partes) }));
    }).on("error", reject);
  });
}
const descomprimir = (r) => {
  const enc = r.headers["content-encoding"];
  const b = enc === "gzip" ? zlib.gunzipSync(r.corpo) : enc === "br" ? zlib.brotliDecompressSync(r.corpo) : r.corpo;
  return JSON.parse(b.toString("utf8"));
};

function firmsCom(pontos) {
  return async (url) => {
    if (String(url).includes("firms.modaps")) return resposta(csv(pontos));
    return { ok: false, status: 404, async text() { return ""; } };
  };
}

// Dados com volume suficiente para passar de 1 KB e comprimir
const MUITOS = Array.from({ length: 400 }, (_, i) => ({ lat: -11.5 - (i % 20) * 0.01, lon: -55.5 - Math.floor(i / 20) * 0.01, frp: 5 + (i % 7) }));

test("/api/focos comprime com gzip ou brotli conforme o Accept-Encoding e informa Vary", async (t) => {
  const porta = await prepararServidor(t, { fetchFalso: firmsCom(MUITOS) });
  const puro = await pegar(porta, "/api/focos", { "Accept-Encoding": "identity" });
  const gz = await pegar(porta, "/api/focos", { "Accept-Encoding": "gzip" });
  const br = await pegar(porta, "/api/focos", { "Accept-Encoding": "gzip, br" });
  assert.equal(puro.headers["content-encoding"], undefined);
  assert.equal(gz.headers["content-encoding"], "gzip");
  assert.equal(br.headers["content-encoding"], "br");
  for (const r of [puro, gz, br]) assert.match(r.headers.vary, /Accept-Encoding/i);
  assert.ok(gz.corpo.length < puro.corpo.length / 3, `gzip deveria encolher bastante (${gz.corpo.length} vs ${puro.corpo.length})`);
  assert.deepEqual(descomprimir(gz), descomprimir(puro));
  assert.deepEqual(descomprimir(br), descomprimir(puro));
  assert.equal(Number(gz.headers["content-length"]), gz.corpo.length);
});

test("ETag: requisição repetida sem mudança de dados volta 304 sem corpo", async (t) => {
  const porta = await prepararServidor(t, { fetchFalso: firmsCom(MUITOS) });
  const a = await pegar(porta, "/api/focos", { "Accept-Encoding": "gzip" });
  const etag = a.headers.etag;
  assert.ok(etag);
  const b = await pegar(porta, "/api/focos", { "Accept-Encoding": "gzip", "If-None-Match": etag });
  assert.equal(b.status, 304);
  assert.equal(b.corpo.length, 0);
  // mesmo ETag para outra codificação (ETag fraco, RFC 9110)
  const c = await pegar(porta, "/api/focos", { "Accept-Encoding": "identity", "If-None-Match": etag });
  assert.equal(c.status, 304);
});

test("a resposta cacheada não repete o trabalho: atualizadoEm é estável entre requisições", async (t) => {
  let downloads = 0;
  const base = firmsCom(MUITOS);
  const porta = await prepararServidor(t, { fetchFalso: async (u, o) => { if (String(u).includes("firms")) downloads++; return base(u, o); } });
  const a = descomprimir(await pegar(porta, "/api/focos", { "Accept-Encoding": "gzip" }));
  await new Promise((r) => setTimeout(r, 15));
  const b = descomprimir(await pegar(porta, "/api/focos", { "Accept-Encoding": "gzip" }));
  assert.equal(a.atualizadoEm, b.atualizadoEm);
  assert.equal(downloads, 3, "um download por satélite, nada mais");
});

test("a resposta só leva os campos que a página usa", async (t) => {
  const porta = await prepararServidor(t, { fetchFalso: firmsCom([{ ...SINOP, frp: 22 }]) });
  const r = descomprimir(await pegar(porta, "/api/focos", { "Accept-Encoding": "identity" }));
  assert.equal(r.total, 1);
  const f = r.focos[0];
  assert.deepEqual(Object.keys(f).sort(), ["confianca", "confirmacoes", "data", "frp", "hora", "lat", "lon", "satelites", "somenteGeo"]);
  assert.equal(f.somenteGeo, false);
  assert.ok(Array.isArray(f.satelites) && f.satelites.length >= 1);
});

test("região: foco fora do polígono é cortado, mesmo estando dentro do BBOX", async (t) => {
  const pontos = [SINOP, MANAUS, CUIABA, SANTA_CRUZ, CAMPO_GRANDE];
  const porta = await prepararServidor(t, { fetchFalso: firmsCom(pontos) });
  const r = descomprimir(await pegar(porta, "/api/focos", { "Accept-Encoding": "identity" }));
  const lats = r.focos.map((f) => f.lat).sort();
  assert.deepEqual(lats, [CUIABA.lat, MANAUS.lat, SINOP.lat].sort());
  assert.equal(r.foraDaRegiao, 1, "Santa Cruz (Bolívia) fica fora do polígono; Campo Grande nem entra no BBOX");
});

test("foco fora da região mas dentro do círculo de uma área monitorada é enviado", async (t) => {
  const area = { id: "fronteira", nome: "Perto da Bolívia", lat: SANTA_CRUZ.lat, lon: SANTA_CRUZ.lon, raio: 25 };
  const porta = await prepararServidor(t, { fetchFalso: firmsCom([SANTA_CRUZ, SINOP]), areas: [area] });
  const r = descomprimir(await pegar(porta, "/api/focos", { "Accept-Encoding": "identity" }));
  assert.equal(r.total, 2);
  assert.equal(r.foraDaRegiao, 0);
});

test("mudar as áreas invalida a resposta guardada", async (t) => {
  const porta = await prepararServidor(t, { fetchFalso: firmsCom([SANTA_CRUZ, SINOP]) });
  const sem = descomprimir(await pegar(porta, "/api/focos", { "Accept-Encoding": "identity" }));
  assert.equal(sem.total, 1);
  monitor.__test.setAreas([{ id: "nova", nome: "Nova", lat: SANTA_CRUZ.lat, lon: SANTA_CRUZ.lon, raio: 10 }]);
  const com = descomprimir(await pegar(porta, "/api/focos", { "Accept-Encoding": "identity" }));
  assert.equal(com.total, 2);
});

test("teto: o que excede MAX_FOCOS_RESPOSTA sai por relevância e focos de áreas nunca são cortados", () => {
  const f = (lat, lon, frp, confirmacoes = 1) => ({ lat, lon, frp, confirmacoes, somenteGeo: false, data: "2026-11-08", hora: "1000", satelites: [] });
  const dentroDaArea = f(-11.86, -55.5, 1);           // fraquinho, mas dentro da área
  const forte = f(-3.12, -60.02, 90);
  const confirmado = f(-3.2, -60.1, 5, 2);
  const medio = f(-3.3, -60.2, 30);
  const fraco = f(-3.4, -60.3, 2);
  const area = { id: "a", nome: "A", lat: -11.86, lon: -55.5, raio: 5 };
  const r = monitor.reduzirParaCliente([fraco, medio, dentroDaArea, confirmado, forte], [area], { teto: 3 });
  assert.equal(r.focos.length, 3);
  assert.equal(r.omitidos, 2);
  assert.ok(r.focos.includes(dentroDaArea), "foco dentro da área é protegido");
  assert.ok(r.focos.includes(confirmado), "confirmado tem prioridade");
  assert.ok(r.focos.includes(forte), "depois, maior potência");
  assert.ok(!r.focos.includes(fraco) && !r.focos.includes(medio));
  // teto 0 = sem limite
  assert.equal(monitor.reduzirParaCliente([fraco, medio, forte], [], { teto: 0 }).omitidos, 0);
});

test("requisições simultâneas com cache vazio compartilham um único download por satélite", async (t) => {
  let downloads = 0;
  const base = firmsCom(MUITOS);
  const porta = await prepararServidor(t, {
    fetchFalso: async (u, o) => {
      if (String(u).includes("firms")) { downloads++; await new Promise((r) => setTimeout(r, 40)); } // "latência de rede"
      return base(u, o);
    },
  });
  const rs = await Promise.all([1, 2, 3, 4, 5].map(() => pegar(porta, "/api/focos", { "Accept-Encoding": "gzip" })));
  assert.ok(rs.every((r) => r.status === 200));
  assert.equal(downloads, 3);
});

test("comCache: falha não é guardada e o próximo pedido tenta de novo", async () => {
  monitor.__test.limparCache();
  let chamadas = 0;
  const buscar = async () => { chamadas++; if (chamadas === 1) throw new Error("caiu"); return "ok"; };
  await assert.rejects(() => monitor.comCache("k", 10, buscar), /caiu/);
  assert.equal(await monitor.comCache("k", 10, buscar), "ok");
  assert.equal(await monitor.comCache("k", 10, buscar), "ok");
  assert.equal(chamadas, 2);
});

test("satélite que falhou não deixa a resposta incompleta grudada no cache", async (t) => {
  let falhaModis = true;
  const porta = await prepararServidor(t, {
    fetchFalso: async (url) => {
      const u = String(url);
      if (u.includes("MODIS") && falhaModis) return { ok: false, status: 500, async text() { return ""; } };
      if (u.includes("MODIS")) return resposta(csv([{ ...MANAUS, frp: 12 }]));
      if (u.includes("firms")) return resposta(csv([{ ...SINOP, frp: 12 }]));
      return { ok: false, status: 404, async text() { return ""; } };
    },
  });
  const a = descomprimir(await pegar(porta, "/api/focos", { "Accept-Encoding": "identity" }));
  assert.ok(a.fontes.find((f) => f.fonte === "MODIS_NRT").erro);
  falhaModis = false;
  const b = descomprimir(await pegar(porta, "/api/focos", { "Accept-Encoding": "identity" }));
  assert.equal(b.fontes.find((f) => f.fonte === "MODIS_NRT").erro, null);
  assert.ok(b.focos.some((f) => Math.abs(f.lat - MANAUS.lat) < 0.01), "o foco do MODIS apareceu sem esperar o cache vencer");
});

test("FIRMS que não responde é interrompida pelo timeout e vira erro claro", async (t) => {
  const porta = await prepararServidor(t, {
    fetchFalso: (url, opcoes = {}) => new Promise((_, rejeitar) => {
      // simula um servidor pendurado que só acaba quando o sinal de timeout dispara
      opcoes.signal?.addEventListener("abort", () => rejeitar(opcoes.signal.reason));
    }),
  });
  monitor.__test.setTimeoutFirmsMs(60);
  const r = await pegar(porta, "/api/focos", { "Accept-Encoding": "identity" });
  assert.equal(r.status, 502);
  assert.match(JSON.parse(r.corpo.toString()).erro, /nenhum satélite respondeu/);
});

test("arquivos estáticos saem comprimidos, com ETag, e 304 quando não mudaram", async (t) => {
  const porta = await prepararServidor(t, { fetchFalso: firmsCom([]) });
  const a = await pegar(porta, "/app.js", { "Accept-Encoding": "gzip" });
  assert.equal(a.status, 200);
  assert.equal(a.headers["content-encoding"], "gzip");
  assert.match(zlib.gunzipSync(a.corpo).toString("utf8"), /sincronizarFocos/);
  const b = await pegar(porta, "/app.js", { "Accept-Encoding": "gzip", "If-None-Match": a.headers.etag });
  assert.equal(b.status, 304);
  const lixo = await pegar(porta, "/%2e%2e/server.js", { "Accept-Encoding": "identity" });
  assert.notEqual(lixo.status, 200, "não pode servir arquivos de fora de public/");
  const regras = await pegar(porta, "/regras-zoom.js", { "Accept-Encoding": "identity" });
  assert.equal(regras.status, 200);
});

test("/api/config informa a região e o retângulo de consulta", async (t) => {
  const porta = await prepararServidor(t, { fetchFalso: firmsCom([]) });
  const cfg = JSON.parse((await pegar(porta, "/api/config", { "Accept-Encoding": "identity" })).corpo.toString());
  assert.ok(cfg.regiao.nome);
  assert.deepEqual(Object.keys(cfg.regiao.bbox).sort(), ["e", "n", "s", "w"]);
  assert.ok(cfg.regiao.bbox.n > 0 && cfg.regiao.bbox.w < -70, "cobre do Acre ao Amapá");
});

test("/api/regiao entrega o contorno da região (comprimido, com ETag) para a página desenhar", async (t) => {
  const porta = await prepararServidor(t, { fetchFalso: firmsCom([]) });
  const gz = await pegar(porta, "/api/regiao", { "Accept-Encoding": "gzip" });
  assert.equal(gz.status, 200);
  assert.equal(gz.headers["content-encoding"], "gzip");
  const geojson = JSON.parse(zlib.gunzipSync(gz.corpo).toString("utf8"));
  assert.equal(geojson.type, "FeatureCollection");
  assert.ok(geojson.features.length >= 1);
  assert.deepEqual(geojson, monitor.regiao.geojson, "é o mesmo GeoJSON que o servidor usa para recortar o mapa");
  const nm = await pegar(porta, "/api/regiao", { "Accept-Encoding": "gzip", "If-None-Match": gz.headers.etag });
  assert.equal(nm.status, 304);
});
