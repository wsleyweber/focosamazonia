const test = require("node:test");
const assert = require("node:assert/strict");
const geo = require("../lib/geo");
const { mensagem, enviarWebhook } = require("../lib/webhook");

function criarAnalise() {
  const horario = new Date().toISOString();
  const area = { nome: "Área teste", lat: -13, lon: -55, raio: 30 };
  const foco = {
    lat: -13,
    lon: -54.98,
    data: horario.slice(0, 10),
    hora: horario.slice(11, 16).replace(":", ""),
    frp: 14.2,
    confianca: "nominal",
    confirmacoes: 2,
    satelites: ["VIIRS NOAA-20", "MODIS"],
  };
  const vento = { direcaoDeGraus: 90, velocidadeKmh: 12, rajadaKmh: 18 };
  return { area, foco, vento, analise: geo.analisarArea(area, [foco], vento) };
}

test("mensagem inclui motivo, idade, rumo, distância e emergência sem exceder limite do Discord", () => {
  const { area, analise, vento } = criarAnalise();
  const texto = mensagem(area, analise, vento, "Novo foco próximo");
  assert.match(texto, /Novo foco próximo/);
  assert.match(texto, /\*\*Foco 1: [\d.]+ km\*\*, a Leste \(L\); observado há [^\r\n]+; satélites: VIIRS NOAA-20, MODIS; confiança: nominal; potência: 14\.2 MW; a favor do vento\./);
  assert.doesNotMatch(texto, /Foco 1: [^\r\n]+\n\s*(?:observado|satélites|confiança|potência)/);
  assert.match(texto, /\*\*Focos mais próximos\*\*\n/);
  assert.match(texto, /\n\n\*\*Vento\*\*\n/);
  assert.match(texto, /confiança: nominal; potência: 14\.2 MW/);
  assert.match(texto, /\n\n> Sem focos detectados/);
  assert.match(texto, /Bombeiros 193/);
  const muitos = { ...analise, total: 1000, dentro: Array.from({ length: 1000 }, (_, i) => ({
    ...analise.dentro[0], km: i / 10,
  })) };
  assert.ok(mensagem(area, muitos, vento).length < 4096);
});

test("foco com mais de 12 horas recebe a marcação de antigo", () => {
  const { area, foco, vento } = criarAnalise();
  const antigo = { ...foco, data: "2000-01-01", hora: "0000" };
  const analise = geo.analisarArea(area, [antigo], vento);
  assert.match(mensagem(area, analise, vento), /observado há mais de 24 h \(antigo\)/);
});

test("webhook genérico preserva campos anteriores e acrescenta os novos", async (t) => {
  const { area, analise, vento } = criarAnalise();
  const originalFetch = global.fetch;
  let corpo;
  global.fetch = async (_url, opcoes) => {
    corpo = Buffer.from(opcoes.body).toString("utf8");
    return { ok: true, status: 200 };
  };
  t.after(() => { global.fetch = originalFetch; });

  await enviarWebhook({ ...area, webhookUrl: "https://example.test/hook" }, analise, vento, Buffer.from("png"), "Novo foco");
  const payloadTexto = corpo.match(/name="payload"\r\n\r\n([\s\S]*?)\r\n------monitorfocosmt/)[1];
  const payload = JSON.parse(payloadTexto);
  for (const chave of ["area", "nivel", "mensagem", "total_focos", "confirmados", "vento", "focos", "em"]) {
    assert.ok(Object.hasOwn(payload, chave), `campo legado ausente: ${chave}`);
  }
  assert.equal(payload.tipo, "alerta");
  assert.equal(payload.motivo, "Novo foco");
  assert.equal(payload.emergencia, "193");
  assert.equal(payload.focos[0].direcao, "Leste (L)");
  assert.equal(payload.focos[0].a_favor_do_vento, true);
  assert.ok(Number.isFinite(payload.focos[0].idade_min));
});
