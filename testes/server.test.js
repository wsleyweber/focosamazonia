const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const monitor = require("../server");
const geo = require("../lib/geo");

function resposta(ok, valor) {
  return {
    ok,
    status: ok ? 200 : 500,
    async text() { return valor || ""; },
    async json() { return valor; },
  };
}

function csvFirms(incluirFoco = true, { lat = -13, lon = -54.98, instante = Date.now() } = {}) {
  const horario = new Date(instante).toISOString();
  const data = horario.slice(0, 10);
  const hora = horario.slice(11, 16).replace(":", "");
  const linhas = [
    "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight",
  ];
  if (incluirFoco) linhas.push(`${lat},${lon},300,1,1,${data},${hora},N20,VIIRS,n,2,290,15,D`);
  return linhas.join("\n");
}

function prepararCiclo(t, {
  area, estado, instante, obterFoco = () => null, direcaoVento = 270,
  responderWebhook = () => true, focosGeo = [],
}) {
  const originalFetch = global.fetch;
  const originalDateNow = Date.now;
  const originalSalvar = monitor.__test.armazenamento.salvarEstado;
  const originalError = console.error;
  const politicaOriginal = monitor.__test.getPoliticaMelhora();
  const modoInpeOriginal = monitor.__test.getModoInpe();
  const geoPodeAlertarOriginal = monitor.cfgAlerta.geoPodeAlertar;
  let agora = instante;
  let direcao = direcaoVento;
  let chamadasWebhook = 0;
  const payloadsWebhook = [];

  Date.now = () => agora;
  monitor.__test.setPoliticaMelhora("todos");
  monitor.__test.setModoInpe("off");
  monitor.__test.setGeoPodeAlertar(geoPodeAlertarOriginal);
  monitor.__test.setAreas([area]);
  monitor.__test.setEstado(estado === undefined ? {} : { [area.id]: estado });
  monitor.__test.armazenamento.salvarEstado = () => {};
  monitor.__test.limparCache();
  console.error = () => {};
  global.fetch = async (url, opcoes = {}) => {
    const destino = String(url);
    if (destino.includes("firms.modaps.eosdis.nasa.gov")) {
      const foco = obterFoco(agora);
      return resposta(true, csvFirms(!!foco, { ...(foco || {}), instante: agora }));
    }
    if (destino.includes("dataserver-coids.inpe.br")) {
      if (!focosGeo.length) return resposta(false);
      const arquivos = focosGeo.map((focoGeo, indice) => {
        const instanteArquivo = agora - (focosGeo.length - indice) * 10 * 60_000;
        const dataHora = new Date(instanteArquivo).toISOString();
        const nome = `focos_10min_${dataHora.slice(0, 10).replace(/-/g, "")}_${dataHora.slice(11, 16).replace(":", "")}.csv`;
        const csv = [
          "lat,lon,satelite,data",
          `${focoGeo.lat},${focoGeo.lon},${focoGeo.satelite || "GOES-19"},${dataHora.slice(0, 10)} ${dataHora.slice(11, 19)}`,
        ].join("\n");
        return { nome, csv };
      });
      if (destino.endsWith("/10min/")) {
        return resposta(true, arquivos.map(({ nome }) => `<a href="${nome}">${nome}</a>`).join("\n"));
      }
      const arquivo = arquivos.find(({ nome }) => destino.endsWith(nome));
      return arquivo ? resposta(true, arquivo.csv) : resposta(false);
    }
    if (destino.includes("api.open-meteo.com")) {
      return { ...resposta(true), async json() { return { current: { wind_speed_10m: 10, wind_direction_10m: direcao, wind_gusts_10m: 12 } }; } };
    }
    if (destino.includes("tile.openstreetmap.org")) return resposta(false);
    if (destino.includes("example.test")) {
      chamadasWebhook++;
      payloadsWebhook.push(Buffer.from(opcoes.body).toString("utf8"));
      return resposta(responderWebhook(chamadasWebhook));
    }
    throw new Error("fetch inesperado");
  };
  t.after(() => {
    global.fetch = originalFetch;
    Date.now = originalDateNow;
    console.error = originalError;
    monitor.__test.armazenamento.salvarEstado = originalSalvar;
    monitor.__test.setPoliticaMelhora(politicaOriginal);
    monitor.__test.setModoInpe(modoInpeOriginal);
    monitor.__test.setGeoPodeAlertar(geoPodeAlertarOriginal);
    monitor.__test.limparCache();
    monitor.__test.setAreas([]);
    monitor.__test.setEstado({});
  });

  return {
    avancar(ms) {
      agora += ms;
      monitor.__test.limparCache();
    },
    setModoInpe(modo) {
      monitor.__test.setModoInpe(modo);
    },
    setGeoPodeAlertar(valor) {
      monitor.__test.setGeoPodeAlertar(valor);
    },
    setDirecaoVento(valor) {
      direcao = valor;
      monitor.__test.limparCache();
    },
    get chamadasWebhook() { return chamadasWebhook; },
    get payloadsWebhook() { return payloadsWebhook; },
  };
}

function payloadWebhook(corpo) {
  const correspondencia = corpo.match(/name="payload"\r\n\r\n([\s\S]*?)\r\n------monitorfocosmt/);
  assert.ok(correspondencia, "payload multipart deve existir");
  return JSON.parse(correspondencia[1]);
}

test("valida raio e coordenadas dentro do retângulo monitorado", () => {
  assert.equal(monitor.erroArea(-13, -55, 25), null);
  assert.match(monitor.erroArea(-13, -55, 0), /raio/);
  assert.match(monitor.erroArea(-13, -55, 501), /raio/);
  assert.match(monitor.erroArea(-25, -55, 25), /latitude e longitude/);
});

test("módulo da imagem exporta a função usada pelo servidor", () => {
  const imagem = require("../lib/imagem");
  assert.equal(typeof imagem.gerarImagemArea, "function");
  assert.equal(typeof imagem.escolherZoom, "function");
});

test("imagem desenha texto usando fonte incorporada, sem depender de fontes do sistema", async (t) => {
  const { createCanvas, loadImage, GlobalFonts } = require("@napi-rs/canvas");
  const { gerarImagemArea } = require("../lib/imagem");
  assert.equal(GlobalFonts.has("Roboto"), true);

  const originalFetch = global.fetch;
  const tile = createCanvas(256, 256);
  tile.getContext("2d").fillRect(0, 0, 256, 256);
  const imagemTile = tile.toBuffer("image/png");
  global.fetch = async () => ({ ok: true, arrayBuffer: async () => imagemTile });
  t.after(() => { global.fetch = originalFetch; });

  const area = { nome: "Fazenda São José", lat: -13, lon: -55, raio: 25 };
  const analise = geo.analisarArea(area, [], null);
  const png = await gerarImagemArea(area, [], null, analise);
  const renderizada = await loadImage(png);
  const canvas = createCanvas(renderizada.width, renderizada.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(renderizada, 0, 0);
  const pixels = ctx.getImageData(0, 0, 640, 46).data;
  let pixelsBrancos = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i] > 220 && pixels[i + 1] > 220 && pixels[i + 2] > 220 && pixels[i + 3] > 0) pixelsBrancos++;
  }
  assert.ok(pixelsBrancos > 100, "a faixa do título deve conter o nome e o nível em branco");
});

test("zoom da imagem maximiza o círculo sem cortar entre título e rodapé", () => {
  const { escolherZoom } = require("../lib/imagem");
  const lat = -13;
  const raioMetros = 200_000;
  const raioMaximoPx = Math.min(640, 440 - 46 - 56) / 2 - 5;
  const zoom = escolherZoom(lat, raioMetros);
  const raioPx = (z) => raioMetros /
    ((156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** z);
  assert.ok(raioPx(zoom) <= raioMaximoPx);
  if (zoom < 15) assert.ok(raioPx(zoom + 1) > raioMaximoPx);
});

test("opacidade do foco segue as faixas de idade do briefing", () => {
  const { opacidadeFoco } = require("../lib/imagem");
  const agora = Date.parse("2026-11-07T12:00:00Z");
  const focoHorasAtras = (horas) => {
    const data = new Date(agora - horas * 60 * 60_000).toISOString();
    return { data: data.slice(0, 10), hora: data.slice(11, 16).replace(":", "") };
  };
  assert.equal(opacidadeFoco(focoHorasAtras(2), agora), 0.9);
  assert.equal(opacidadeFoco(focoHorasAtras(6), agora), 0.65);
  assert.equal(opacidadeFoco(focoHorasAtras(20), agora), 0.4);
  assert.equal(opacidadeFoco(focoHorasAtras(25), agora), 0.25);
  assert.equal(opacidadeFoco({}, agora), 0.4);
});

test("filtro do servidor descarta confiança abaixo da configuração", () => {
  const focos = [
    { confianca: "baixa" },
    { confianca: "nominal" },
    { confianca: "alta" },
  ];
  const filtrados = monitor.focosParaAlerta(focos);
  const ordem = { baixa: 0, nominal: 1, alta: 2 };
  const minimo = ordem[monitor.CONFIANCA_MINIMA];
  assert.ok(filtrados.every((f) => ordem[f.confianca] >= minimo));
});

test("janela de FIRMS mede 24 horas reais em UTC, cruzando a meia-noite", () => {
  const agora = Date.parse("2026-11-06T02:42:00Z");
  const focos = [
    { data: "2026-11-05", hora: "2300" },
    { data: "2026-11-06", hora: "0100" },
    { data: "2026-11-04", hora: "2300" },
  ];
  assert.deepEqual(monitor.filtrarJanelaFocos(focos, 1, agora), focos.slice(0, 2));
});

test("baseline de estado legado registra os focos sem disparar webhook", async (t) => {
  monitor.__test.limparCache();
  const originalFetch = global.fetch;
  const originalSalvar = monitor.__test.armazenamento.salvarEstado;
  const originalError = console.error;
  let chamadasWebhook = 0;
  monitor.__test.setAreas([{ id: "baseline", nome: "Área", lat: -13, lon: -55, raio: 50, webhookUrl: "https://example.test/hook" }]);
  monitor.__test.setEstado({ baseline: { nivel: "alto", em: new Date().toISOString() } });
  monitor.__test.armazenamento.salvarEstado = () => {};
  console.error = () => {};
  global.fetch = async (url) => {
    const destino = String(url);
    if (destino.includes("firms.modaps.eosdis.nasa.gov")) return resposta(true, csvFirms());
    if (destino.includes("api.open-meteo.com")) {
      return { ...resposta(true), async json() { return { current: { wind_speed_10m: 8, wind_direction_10m: 270 } }; } };
    }
    if (destino.includes("tile.openstreetmap.org")) return resposta(false);
    if (destino.includes("example.test")) chamadasWebhook++;
    return resposta(true);
  };
  t.after(() => {
    global.fetch = originalFetch;
    console.error = originalError;
    monitor.__test.armazenamento.salvarEstado = originalSalvar;
    monitor.__test.setAreas([]);
    monitor.__test.setEstado({});
  });

  await monitor.cicloMonitor();
  assert.equal(chamadasWebhook, 0);
  assert.equal(monitor.__test.getEstado().baseline.avisados.length, 1);
});

test("primeira leitura de área nova com foco próximo envia o motivo específico", async (t) => {
  const instante = Date.parse("2026-11-06T12:00:00Z");
  const area = { id: "primeira-leitura", nome: "Área teste", lat: -13, lon: -55, raio: 50, webhookUrl: "https://example.test/hook" };
  const controle = prepararCiclo(t, {
    area,
    instante,
    estado: undefined,
    obterFoco: () => ({ lat: -13, lon: -55 + 3 / 108 }),
  });

  await monitor.cicloMonitor();

  assert.equal(controle.chamadasWebhook, 1);
  assert.equal(payloadWebhook(controle.payloadsWebhook[0]).motivo, "Primeira leitura da área");
  assert.equal(monitor.__test.getEstado()[area.id].avisados.length, 1);
});

test("primeira leitura de área nova sem focos não envia webhook", async (t) => {
  const area = { id: "primeira-leitura-vazia", nome: "Área teste", lat: -13, lon: -55, raio: 50, webhookUrl: "https://example.test/hook" };
  const controle = prepararCiclo(t, {
    area,
    instante: Date.parse("2026-11-06T12:00:00Z"),
    estado: undefined,
    obterFoco: () => null,
  });

  await monitor.cicloMonitor();

  assert.equal(controle.chamadasWebhook, 0);
  assert.equal(monitor.__test.getEstado()[area.id].nivel, "ok");
  assert.deepEqual(monitor.__test.getEstado()[area.id].avisados, []);
});

test("falha na primeira leitura não grava estado e reenvia no ciclo seguinte", async (t) => {
  const area = { id: "primeira-leitura-reenvio", nome: "Área teste", lat: -13, lon: -55, raio: 50, webhookUrl: "https://example.test/hook" };
  const controle = prepararCiclo(t, {
    area,
    instante: Date.parse("2026-11-06T12:00:00Z"),
    estado: undefined,
    obterFoco: () => ({ lat: -13, lon: -55 + 3 / 108 }),
    responderWebhook: (tentativa) => tentativa > 1,
  });

  await monitor.cicloMonitor();
  assert.equal(controle.chamadasWebhook, 1);
  assert.equal(Object.hasOwn(monitor.__test.getEstado(), area.id), false);

  await monitor.cicloMonitor();
  assert.equal(controle.chamadasWebhook, 2);
  assert.equal(payloadWebhook(controle.payloadsWebhook[1]).motivo, "Primeira leitura da área");
  assert.equal(monitor.__test.getEstado()[area.id].avisados.length, 1);
});

test("foco detectado após ciclo anterior sem focos dispara aviso", async (t) => {
  monitor.__test.limparCache();
  const originalFetch = global.fetch;
  const originalSalvar = monitor.__test.armazenamento.salvarEstado;
  const originalError = console.error;
  let incluirFoco = false;
  let chamadasWebhook = 0;
  monitor.__test.setAreas([{ id: "novo", nome: "Área", lat: -13, lon: -55, raio: 50, webhookUrl: "https://example.test/hook" }]);
  monitor.__test.setEstado({ novo: { nivel: "ok", em: new Date().toISOString() } });
  monitor.__test.armazenamento.salvarEstado = () => {};
  console.error = () => {};
  global.fetch = async (url) => {
    const destino = String(url);
    if (destino.includes("firms.modaps.eosdis.nasa.gov")) return resposta(true, csvFirms(incluirFoco));
    if (destino.includes("api.open-meteo.com")) {
      return { ...resposta(true), async json() { return { current: { wind_speed_10m: 8, wind_direction_10m: 270 } }; } };
    }
    if (destino.includes("tile.openstreetmap.org")) return resposta(false);
    if (destino.includes("example.test")) chamadasWebhook++;
    return resposta(true);
  };
  t.after(() => {
    global.fetch = originalFetch;
    console.error = originalError;
    monitor.__test.armazenamento.salvarEstado = originalSalvar;
    monitor.__test.setAreas([]);
    monitor.__test.setEstado({});
  });

  await monitor.cicloMonitor();
  assert.deepEqual(monitor.__test.getEstado().novo.avisados, []);
  incluirFoco = true;
  monitor.__test.limparCache();
  await monitor.cicloMonitor();
  assert.equal(chamadasWebhook, 1);
});

test("falha total da FIRMS não atualiza o estado da área", async (t) => {
  monitor.__test.limparCache();
  const originalFetch = global.fetch;
  const originalSalvar = monitor.__test.armazenamento.salvarEstado;
  const originalError = console.error;
  const estadoAnterior = { falha: { nivel: "alto", em: "2026-11-06T12:00:00Z", avisados: [] } };
  monitor.__test.setAreas([{ id: "falha", nome: "Área", lat: -13, lon: -55, raio: 50 }]);
  monitor.__test.setEstado(estadoAnterior);
  monitor.__test.armazenamento.salvarEstado = () => assert.fail("não deve persistir estado após falha total");
  console.error = () => {};
  global.fetch = async () => resposta(false);
  t.after(() => {
    global.fetch = originalFetch;
    console.error = originalError;
    monitor.__test.armazenamento.salvarEstado = originalSalvar;
    monitor.__test.setAreas([]);
    monitor.__test.setEstado({});
  });

  await monitor.cicloMonitor();
  assert.equal(monitor.__test.getEstado().falha.nivel, "alto");
  assert.equal(monitor.__test.getEstado().falha.em, "2026-11-06T12:00:00Z");
});

test("ciclo reenvia após HTTP 500 e não grava foco como avisado até sucesso", async (t) => {
  monitor.__test.limparCache();
  const originalFetch = global.fetch;
  const originalSalvar = monitor.__test.armazenamento.salvarEstado;
  const originalError = console.error;
  const anterior = {
    nivel: "alto",
    nivelNotificado: "alto",
    avisados: [{ lat: -13, lon: -54.75, km: 27, t: new Date().toISOString() }],
  };
  const area = { id: "teste", nome: "Área teste", lat: -13, lon: -55, raio: 50, webhookUrl: "https://example.test/hook" };
  const persistidos = [];
  let tentativasWebhook = 0;
  let chamadasFirms = 0;

  monitor.__test.setAreas([area]);
  monitor.__test.setEstado({ teste: anterior });
  monitor.__test.armazenamento.salvarEstado = (estado) => persistidos.push(JSON.parse(JSON.stringify(estado)));
  console.error = () => {};
  global.fetch = async (url) => {
    const destino = String(url);
    if (destino.includes("firms.modaps.eosdis.nasa.gov")) {
      chamadasFirms++;
      return resposta(true, csvFirms());
    }
    if (destino.includes("api.open-meteo.com")) {
      return { ...resposta(true), async json() { return { current: { wind_speed_10m: 8, wind_direction_10m: 270, wind_gusts_10m: 10 } }; } };
    }
    if (destino.includes("tile.openstreetmap.org")) return resposta(false);
    if (destino.includes("example.test")) {
      tentativasWebhook++;
      return resposta(tentativasWebhook > 1);
    }
    throw new Error("fetch inesperado");
  };
  t.after(() => {
    global.fetch = originalFetch;
    console.error = originalError;
    monitor.__test.armazenamento.salvarEstado = originalSalvar;
    monitor.__test.setAreas([]);
    monitor.__test.setEstado({});
  });

  await monitor.cicloMonitor();
  assert.equal(tentativasWebhook, 1);
  assert.deepEqual(monitor.__test.getEstado().teste.avisados, anterior.avisados);
  assert.equal(monitor.__test.getEstado().teste.ultimoEnvio, undefined);
  await monitor.cicloMonitor();
  assert.equal(tentativasWebhook, 2);
  assert.equal(monitor.__test.getEstado().teste.avisados.length, 1);
  assert.ok(monitor.__test.getEstado().teste.ultimoEnvio);
  await monitor.cicloMonitor();
  assert.equal(tentativasWebhook, 2);
  assert.equal(chamadasFirms, 3);
  assert.equal(persistidos.length, 3);
});

test("aviso de melhora após o tempo configurado informa que o vento mudou", async (t) => {
  const instante = Date.parse("2026-11-06T12:00:00Z");
  const foco = { lat: -13, lon: -55 + 20 / 108 };
  const area = { id: "melhora-vento", nome: "Área teste", lat: -13, lon: -55, raio: 50, webhookUrl: "https://example.test/hook" };
  const controle = prepararCiclo(t, {
    area,
    instante,
    estado: {
      nivel: "alto",
      nivelNotificado: "alto",
      avisados: [{ ...foco, km: 20, t: new Date(instante).toISOString() }],
    },
    obterFoco: () => foco,
  });

  await monitor.cicloMonitor();
  const melhoraDesde = monitor.__test.getEstado()[area.id].melhoraDesde;
  assert.ok(melhoraDesde);
  assert.equal(controle.chamadasWebhook, 0);

  controle.avancar(monitor.__test.melhoraMinutos * 60_000);
  await monitor.cicloMonitor();

  assert.equal(controle.chamadasWebhook, 1);
  const payload = payloadWebhook(controle.payloadsWebhook[0]);
  assert.equal(payload.tipo, "melhora");
  assert.match(payload.mensagem, /Os 1 focos continuam no raio, mas já não estão a favor do vento \(vento ou idade do foco\)/);
  assert.match(payload.mensagem, /Mais próximo a \d+\.\d km, observado há/);
  assert.match(payload.mensagem, /Emergência: Corpo de Bombeiros 193/);
  assert.doesNotMatch(payload.mensagem, /fogo apagou|área segura|incêndio controlado/i);
  assert.equal(monitor.__test.getEstado()[area.id].nivelNotificado, "atencao");
  assert.equal(monitor.__test.getEstado()[area.id].melhoraDesde, undefined);
});

test("subida para Alerta envia mesmo dentro do intervalo mínimo", async (t) => {
  const instante = Date.parse("2026-11-06T12:00:00Z");
  const foco = { lat: -13, lon: -55 + 20 / 108 };
  const area = { id: "subida-alerta", nome: "Área teste", lat: -13, lon: -55, raio: 50, webhookUrl: "https://example.test/hook" };
  const controle = prepararCiclo(t, {
    area,
    instante,
    direcaoVento: 90,
    estado: {
      nivel: "atencao",
      nivelNotificado: "atencao",
      avisados: [{ ...foco, km: 20, t: new Date(instante).toISOString() }],
      ultimoEnvio: new Date(instante - 10 * 60_000).toISOString(),
    },
    obterFoco: () => foco,
  });

  await monitor.cicloMonitor();

  assert.equal(controle.chamadasWebhook, 1);
  assert.equal(payloadWebhook(controle.payloadsWebhook[0]).motivo, "Nível subiu para Alerta");
});

test("melhora cancela se o nível voltar e reinicia se cair novamente", async (t) => {
  const instante = Date.parse("2026-11-06T12:00:00Z");
  const foco = { lat: -13, lon: -55 + 20 / 108 };
  const area = { id: "melhora-cancela", nome: "Área teste", lat: -13, lon: -55, raio: 50, webhookUrl: "https://example.test/hook" };
  const controle = prepararCiclo(t, {
    area,
    instante,
    estado: {
      nivel: "alto",
      nivelNotificado: "alto",
      avisados: [{ ...foco, km: 20, t: new Date(instante).toISOString() }],
    },
    obterFoco: () => foco,
  });

  await monitor.cicloMonitor();
  assert.ok(monitor.__test.getEstado()[area.id].melhoraDesde);
  controle.avancar(30 * 60_000);
  controle.setDirecaoVento(90);
  await monitor.cicloMonitor();
  assert.equal(monitor.__test.getEstado()[area.id].melhoraDesde, undefined);
  assert.equal(controle.chamadasWebhook, 0);

  controle.setDirecaoVento(270);
  await monitor.cicloMonitor();
  assert.equal(monitor.__test.getEstado()[area.id].melhoraDesde, new Date(instante + 30 * 60_000).toISOString());
});

test("falha ao enviar melhora conserva o nível notificado e permite nova tentativa", async (t) => {
  const instante = Date.parse("2026-11-06T12:00:00Z");
  const area = { id: "melhora-reenvio", nome: "Área teste", lat: -13, lon: -55, raio: 50, webhookUrl: "https://example.test/hook" };
  const controle = prepararCiclo(t, {
    area,
    instante,
    estado: { nivel: "atencao", nivelNotificado: "atencao", avisados: [] },
    obterFoco: () => null,
    responderWebhook: (tentativa) => tentativa > 1,
  });

  await monitor.cicloMonitor();
  controle.avancar(monitor.__test.melhoraMinutos * 60_000);
  await monitor.cicloMonitor();
  const estadoFalha = monitor.__test.getEstado()[area.id];
  assert.equal(controle.chamadasWebhook, 1);
  assert.equal(estadoFalha.nivelNotificado, "atencao");
  assert.ok(estadoFalha.melhoraDesde);

  await monitor.cicloMonitor();
  const estadoSucesso = monitor.__test.getEstado()[area.id];
  assert.equal(controle.chamadasWebhook, 2);
  assert.equal(estadoSucesso.nivelNotificado, "ok");
  assert.equal(estadoSucesso.melhoraDesde, undefined);
  const payload = payloadWebhook(controle.payloadsWebhook[1]);
  assert.match(payload.mensagem, /Nenhum foco detectado nas últimas 24 h/);
  assert.match(payload.mensagem, /Isso não confirma que o fogo apagou/);
  assert.doesNotMatch(payload.mensagem, /(?:^|\n)(?:A área está segura|Fogo apagado|Incêndio controlado)/i);
});

test("novo foco perto tem prioridade sobre o motivo menos importante", async (t) => {
  const instante = Date.parse("2026-11-06T12:00:00Z");
  const area = { id: "motivos-prioridade", nome: "Área teste", lat: -13, lon: -55, raio: 50, webhookUrl: "https://example.test/hook" };
  const focoAnterior = { lat: -13, lon: -55 + 20 / 108 };
  const focoNovo = { lat: -13, lon: -55 + 3 / 108 };
  const controle = prepararCiclo(t, {
    area,
    instante,
    estado: {
      nivel: "alto",
      nivelNotificado: "alto",
      avisados: [{ ...focoAnterior, km: 20, t: new Date(instante).toISOString() }],
    },
    obterFoco: () => focoNovo,
  });

  await monitor.cicloMonitor();
  assert.equal(controle.chamadasWebhook, 1);
  const payload = payloadWebhook(controle.payloadsWebhook[0]);
  assert.match(payload.motivo, /^Novo foco a 3\.0 km/);
});

test("foco inicial sem histórico não é aproximação", async (t) => {
  const instante = Date.parse("2026-11-06T12:00:00Z");
  const areaSemHistorico = { id: "sem-historico", nome: "Área teste", lat: -13, lon: -55, raio: 50, webhookUrl: "https://example.test/hook" };
  const semHistorico = prepararCiclo(t, {
    area: areaSemHistorico,
    instante,
    estado: { nivel: "atencao", nivelNotificado: "atencao", avisados: [] },
    obterFoco: () => ({ lat: -13, lon: -55 + 30 / 108 }),
  });
  await monitor.cicloMonitor();
  assert.equal(semHistorico.chamadasWebhook, 0);
});

test("aproximação que supera a margem configurada gera reaviso", async (t) => {
  const instante = Date.parse("2026-11-06T12:00:00Z");
  const area = { id: "aproximacao", nome: "Área teste", lat: -13, lon: -55, raio: 50, webhookUrl: "https://example.test/hook" };
  const controle = prepararCiclo(t, {
    area,
    instante,
    estado: {
      nivel: "atencao",
      nivelNotificado: "atencao",
      avisados: [{ lat: -13, lon: -55 + 30 / 108, km: 30, t: new Date(instante).toISOString() }],
    },
    obterFoco: () => ({ lat: -13, lon: -55 + 27.5 / 108 }),
  });

  await monitor.cicloMonitor();
  assert.equal(controle.chamadasWebhook, 1);
  assert.equal(payloadWebhook(controle.payloadsWebhook[0]).motivo, "Foco mais próximo que os anteriores");
});

test("aproximação abaixo da margem não gera reaviso", async (t) => {
  const instante = Date.parse("2026-11-06T12:00:00Z");
  const area = { id: "aproximacao-curta", nome: "Área teste", lat: -13, lon: -55, raio: 50, webhookUrl: "https://example.test/hook" };
  const controle = prepararCiclo(t, {
    area,
    instante,
    estado: {
      nivel: "atencao",
      nivelNotificado: "atencao",
      avisados: [{ lat: -13, lon: -55 + 30 / 108, km: 30, t: new Date(instante).toISOString() }],
    },
    obterFoco: () => ({ lat: -13, lon: -55 + 28.1 / 108 }),
  });

  await monitor.cicloMonitor();
  assert.equal(controle.chamadasWebhook, 0);
});

test("políticas de aviso de melhora e redução silenciosa são respeitadas", async (t) => {
  const instante = Date.parse("2026-11-06T12:00:00Z");
  const area = { id: "melhora-politica", nome: "Área teste", lat: -13, lon: -55, raio: 50, webhookUrl: "https://example.test/hook" };
  const controle = prepararCiclo(t, {
    area,
    instante,
    estado: { nivel: "atencao", nivelNotificado: "atencao", avisados: [] },
    obterFoco: () => null,
  });
  monitor.__test.setPoliticaMelhora("apos_alerta");
  assert.equal(monitor.__test.melhoraCoberta("atencao"), false);
  assert.equal(monitor.__test.melhoraCoberta("alto"), true);

  await monitor.cicloMonitor();
  controle.avancar(monitor.__test.melhoraMinutos * 60_000);
  await monitor.cicloMonitor();
  const estado = monitor.__test.getEstado()[area.id];
  assert.equal(controle.chamadasWebhook, 0);
  assert.equal(estado.nivelNotificado, "ok");
  assert.equal(estado.melhoraDesde, undefined);
  assert.equal(monitor.__test.melhoraCoberta("ok", "nunca"), false);
});

test("foco só geoestacionário não avisa sem permissão, mas avisa com GEO_PODE_ALERTAR", async (t) => {
  const instante = Date.parse("2026-11-06T12:00:00Z");
  const focoGeo = { lat: -13, lon: -55 + 4 / 108, satelite: "GOES-19" };
  const area = { id: "geo-sem-alerta", nome: "Área teste", lat: -13, lon: -55, raio: 50, webhookUrl: "https://example.test/hook" };
  const controle = prepararCiclo(t, {
    area,
    instante,
    estado: { nivel: "atencao", nivelNotificado: "atencao", avisados: [] },
    focosGeo: [focoGeo, focoGeo],
  });
  controle.setModoInpe("on");
  controle.setGeoPodeAlertar(false);

  await monitor.cicloMonitor();
  assert.equal(controle.chamadasWebhook, 0);

  controle.setGeoPodeAlertar(true);
  await monitor.cicloMonitor();
  assert.equal(controle.chamadasWebhook, 1);
});

test("foco só geo não dispara em área nova, mas confirmação VIIRS dispara", async (t) => {
  const instante = Date.parse("2026-11-06T12:00:00Z");
  const foco = { lat: -13, lon: -55 + 4 / 108 };
  const area = { id: "geo-confirmado", nome: "Área teste", lat: -13, lon: -55, raio: 50, webhookUrl: "https://example.test/hook" };
  let focoPolar = null;
  const controle = prepararCiclo(t, {
    area,
    instante,
    focosGeo: [{ ...foco, satelite: "GOES-19" }, { ...foco, satelite: "GOES-19" }],
    obterFoco: () => focoPolar,
  });
  controle.setModoInpe("on");
  controle.setGeoPodeAlertar(false);

  await monitor.cicloMonitor();

  assert.equal(controle.chamadasWebhook, 0);
  assert.equal(monitor.__test.getEstado()[area.id].nivel, "ok");
  assert.equal(monitor.__test.getEstado()[area.id].nivelNotificado, "ok");

  focoPolar = foco;
  controle.avancar(10 * 60_000);
  await monitor.cicloMonitor();

  assert.equal(controle.chamadasWebhook, 1);
  const payload = payloadWebhook(controle.payloadsWebhook[0]);
  assert.equal(payload.motivo, "Nível subiu para Alerta");
  assert.ok(payload.focos[0].satelites.includes("VIIRS NOAA-20"));
});

test("API rejeita áreas fora do BBOX e raio inválido", async (t) => {
  const servidor = monitor.servidor;
  const originalSalvar = monitor.__test.armazenamento.salvarAreas;
  monitor.__test.armazenamento.salvarAreas = () => {};
  monitor.__test.setAreas([{ id: "editar", nome: "Existente", lat: -13, lon: -55, raio: 20 }]);
  await new Promise((resolve) => servidor.listen(0, "127.0.0.1", resolve));
  const porta = servidor.address().port;
  t.after(() => {
    servidor.close();
    monitor.__test.armazenamento.salvarAreas = originalSalvar;
    monitor.__test.setAreas([]);
  });

  async function requisicao(metodo, caminho, corpo) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: "127.0.0.1", port: porta, path: caminho, method: metodo,
        headers: { "Content-Type": "application/json" },
      }, (res) => {
        let texto = "";
        res.setEncoding("utf8");
        res.on("data", (parte) => { texto += parte; });
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(texto) }));
      });
      req.on("error", reject);
      req.end(corpo === undefined ? undefined : JSON.stringify(corpo));
    });
  }

  monitor.__test.setAreas([{
    id: "editar", nome: "Existente", lat: -13, lon: -55, raio: 20,
    webhookUrl: "https://example.test/segredo",
  }]);
  const areas = await requisicao("GET", "/api/areas");
  assert.equal(areas.status, 200);
  assert.equal(areas.body[0].webhookConfigurado, true);
  assert.equal(Object.hasOwn(areas.body[0], "webhookUrl"), false);
  assert.equal(JSON.stringify(areas.body).includes("example.test/segredo"), false);

  const patch = await requisicao("PATCH", "/api/areas/editar", { webhookUrl: "https://example.test/novo-segredo" });
  assert.equal(patch.status, 200);
  assert.equal(patch.body.webhookConfigurado, true);
  assert.equal(Object.hasOwn(patch.body, "webhookUrl"), false);
  assert.equal(JSON.stringify(patch.body).includes("novo-segredo"), false);

  const criada = await requisicao("POST", "/api/areas", {
    nome: "Nova área", lat: -13, lon: -55, raio: 20, webhookUrl: "https://example.test/novo-segredo",
  });
  assert.equal(criada.status, 201);
  assert.equal(criada.body.webhookConfigurado, true);
  assert.equal(Object.hasOwn(criada.body, "webhookUrl"), false);
  assert.equal(JSON.stringify(criada.body).includes("novo-segredo"), false);

  assert.equal((await requisicao("POST", "/api/areas", { nome: "Fora", lat: -25, lon: -55, raio: 20 })).status, 400);
  assert.equal((await requisicao("POST", "/api/areas", { nome: "Raio", lat: -13, lon: -55, raio: 501 })).status, 400);
  assert.equal((await requisicao("PATCH", "/api/areas/editar", { raio: -1 })).status, 400);
  const config = await requisicao("GET", "/api/config");
  assert.equal(config.status, 200);
  assert.equal(config.body.confiancaMinima, monitor.CONFIANCA_MINIMA);
  assert.equal(config.body.emergencia, "193");
});
