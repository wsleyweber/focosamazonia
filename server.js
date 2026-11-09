// Monitor de focos de incêndio - Amazônia (região definida em assets/regiao.geojson)
// Servidor sem dependências pesadas (Node 20+, só @napi-rs/canvas para desenhar a imagem).
// Faz proxy da NASA FIRMS, da Open-Meteo e do OpenStreetMap, mantém cache, serve a pasta public/
// e roda sozinho em intervalo para avisar por webhook, mesmo com a página fechada.
const http = require("http");
const fs = require("fs");
const path = require("path");
const geo = require("./lib/geo");
const { gerarImagemArea } = require("./lib/imagem");
const { enviarWebhook } = require("./lib/webhook");
const inpe = require("./lib/inpe");
const { criarObservador } = require("./lib/observacao-geo");
const armazenamento = require("./lib/armazenamento");
const { carregarRegiao } = require("./lib/regiao");
const { prepararImovel, validarFolga } = require("./lib/imovel");
const AreaGeo = require("./public/area-geo");
const { parsearCsvFirms, nivelConfianca } = require("./lib/firms");
const { CorpoComprimivel, enviarCorpo, enviarBufferPequeno } = require("./lib/compressao");
const crypto = require("crypto");

// Carrega .env simples, se existir
try {
  for (const linha of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split("\n")) {
    const m = linha.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}

const PORT = process.env.PORT || 3000;
// Por padrão só aceita conexões da própria máquina. Em Docker ou atrás de proxy em outra máquina, use HOST=0.0.0.0.
const HOST = process.env.HOST || "127.0.0.1";
const MAP_KEY = process.env.FIRMS_MAP_KEY || "";
const CACHE_MIN = Number(process.env.CACHE_MINUTOS || 10);
const MONITOR_MIN = Number(process.env.MONITOR_MINUTOS || 10);
const WEBHOOK_URL_PADRAO = process.env.WEBHOOK_URL || ""; // usado por áreas sem webhook próprio
const WEBHOOK_NIVEL_MINIMO = ["ok", "atencao", "alto"].includes(process.env.WEBHOOK_NIVEL_MINIMO)
  ? process.env.WEBHOOK_NIVEL_MINIMO : "atencao";
function numeroConfig(nome, padrao) {
  const valor = Number(process.env[nome]);
  return process.env[nome] && Number.isFinite(valor) && valor >= 0 ? valor : padrao;
}
const cfgAlerta = {
  distAlertaKm: numeroConfig("DIST_ALERTA_KM", geo.CONFIG_PADRAO.distAlertaKm),
  ventoMaxKm: numeroConfig("VENTO_MAX_KM", geo.CONFIG_PADRAO.ventoMaxKm),
  ventoMinKmh: numeroConfig("VENTO_MIN_KMH", geo.CONFIG_PADRAO.ventoMinKmh),
  idadeMaxVentoH: numeroConfig("IDADE_MAX_VENTO_H", geo.CONFIG_PADRAO.idadeMaxVentoH),
  geoPodeAlertar: process.env.GEO_PODE_ALERTAR === "true",
};
const CONFIANCA_MINIMA = ["baixa", "nominal", "alta"].includes(process.env.CONFIANCA_MINIMA)
  ? process.env.CONFIANCA_MINIMA : "nominal";
const ENVIO_INTERVALO_MIN = numeroConfig("ENVIO_INTERVALO_MIN", 30);
const APROX_MARGEM_KM = numeroConfig("APROX_MARGEM_KM", 2);
const MELHORA_MINUTOS = numeroConfig("MELHORA_MINUTOS", 60);
let AVISAR_MELHORA = ["todos", "apos_alerta", "nunca"].includes(process.env.AVISAR_MELHORA)
  ? process.env.AVISAR_MELHORA : "todos";
let MODO_INPE = ["off", "observar", "on"].includes(process.env.INPE_GEO) ? process.env.INPE_GEO : "off";
const DEDUP_GEO_KM = numeroConfig("DEDUP_GEO_KM", 4);
const GEO_MIN_DETECCOES = Math.max(1, Math.floor(numeroConfig("GEO_MIN_DETECCOES", 2)));
const GEO_JANELA_HORAS = Math.max(1, Math.floor(numeroConfig("GEO_JANELA_HORAS", 3)));
const CACHE_GEO_MINUTOS = numeroConfig("CACHE_GEO_MINUTOS", 5);
const ORDEM_CONF = { baixa: 0, nominal: 1, alta: 2 };
// Região grande = downloads grandes: sem limite, uma conexão pendurada travaria o ciclo do monitor e as páginas.
let FIRMS_TIMEOUT_MS = Math.max(5, numeroConfig("FIRMS_TIMEOUT_SEGUNDOS", 90)) * 1000;
// Teto de focos enviados à página (0 = sem teto). Focos dentro das áreas monitoradas nunca são cortados.
const MAX_FOCOS_RESPOSTA = Math.floor(numeroConfig("MAX_FOCOS_RESPOSTA", 30000));

// Lista em memória, persistida em dados/areas.json e dados/estado.json a cada mudança
let areas = armazenamento.listarAreas();
let estadoAlertas = armazenamento.lerEstado(); // id da área -> { nivel, em }

// Região monitorada: polígono gerado por scripts/gerar-regiao.js a partir de shapefiles do IBGE.
// BBOX (oeste, sul, leste, norte) é o retângulo que a envolve: é o que se pede à FIRMS e o que valida áreas novas.
// O polígono só enxuga o que vai para o mapa; os alertas do monitor usam todos os focos do BBOX.
const BBOX_LEGADO_MT = { w: -61.7, s: -18.1, e: -50.2, n: -7.3 };
const ARQUIVO_REGIAO = process.env.REGIAO_ARQUIVO || path.join(__dirname, "assets", "regiao.geojson");
let regiao = null;
try {
  regiao = carregarRegiao(ARQUIVO_REGIAO);
} catch (e) {
  console.error(`região: não foi possível carregar ${path.basename(ARQUIVO_REGIAO)} (${e.message}); usando só o retângulo do Mato Grosso`);
}
const BBOX = regiao ? { ...regiao.bbox } : { ...BBOX_LEGADO_MT };
const NOME_REGIAO = regiao ? regiao.nome : "Mato Grosso";
// Contorno que a página desenha no mapa (GET /api/regiao). Sem o arquivo da região, cai no retângulo do fallback.
const GEOJSON_REGIAO = regiao ? regiao.geojson : {
  type: "FeatureCollection", name: NOME_REGIAO,
  features: [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[
    [BBOX.w, BBOX.s], [BBOX.e, BBOX.s], [BBOX.e, BBOX.n], [BBOX.w, BBOX.n], [BBOX.w, BBOX.s],
  ]] } }],
};

// O VIIRS Suomi NPP (VIIRS_SNPP_NRT) parou de ser atualizado no FIRMS em 02/11/2026; por isso ficou de fora.
// NOAA-20 e NOAA-21 são os substitutos oficiais. O MODIS segue disponível, mas a NASA já planeja a saída dele.
const FONTES_FIRMS = ["VIIRS_NOAA20_NRT", "VIIRS_NOAA21_NRT", "MODIS_NRT"];
// Arquivos sem chave (24h) por satélite, região América do Sul
const ARQUIVOS_SEM_CHAVE = {
  VIIRS_NOAA20_NRT: "noaa-20-viirs-c2/csv/J1_VIIRS_C2_South_America_24h.csv",
  VIIRS_NOAA21_NRT: "noaa-21-viirs-c2/csv/J2_VIIRS_C2_South_America_24h.csv",
  MODIS_NRT: "modis-c6.1/csv/MODIS_C6_1_South_America_24h.csv",
};
const NOME_FONTE = {
  VIIRS_NOAA20_NRT: "VIIRS NOAA-20",
  VIIRS_NOAA21_NRT: "VIIRS NOAA-21",
  MODIS_NRT: "MODIS",
};
const ORDEM_NIVEL = { ok: 0, atencao: 1, alto: 2 };

function melhoraCoberta(nivelNotificado, politica = AVISAR_MELHORA) {
  if (politica === "todos") return true;
  return politica === "apos_alerta" && nivelNotificado === "alto";
}
// Focos a menos de DEDUP_KM um do outro, vistos por satélites diferentes, contam como o mesmo fogo
const DEDUP_KM = Number(process.env.DEDUP_KM || 1.5);
const observadorGeo = criarObservador(
  path.join(__dirname, "dados", "observacao-geo.jsonl"),
  DEDUP_GEO_KM,
  geo.distanciaKm
);

const cache = new Map();
const emAndamento = new Map(); // chave -> promessa da busca em curso
// Várias requisições com o cache vencido compartilham UMA busca (antes, cada uma baixava tudo de novo).
async function comCache(chave, minutos, buscar) {
  const hit = cache.get(chave);
  if (hit && Date.now() - hit.t < minutos * 60000) return hit.v;
  if (emAndamento.has(chave)) return emAndamento.get(chave);
  const promessa = (async () => {
    try {
      const v = await buscar();
      cache.set(chave, { t: Date.now(), v, minutos });
      if (cache.size > 500) {
        const agora = Date.now();
        for (const [k, e] of cache) if (agora - e.t >= e.minutos * 60000) cache.delete(k);
      }
      return v;
    } finally {
      emAndamento.delete(chave);
    }
  })();
  emAndamento.set(chave, promessa);
  return promessa;
}

function focosParaAlerta(focos) {
  return focos.filter((f) => ORDEM_CONF[f.confianca] >= ORDEM_CONF[CONFIANCA_MINIMA]);
}

function sanitizarErro(erro) {
  let mensagem = String(erro?.message || erro);
  if (WEBHOOK_URL_PADRAO) mensagem = mensagem.split(WEBHOOK_URL_PADRAO).join("[webhook]");
  if (MAP_KEY) mensagem = mensagem.split(MAP_KEY).join("[FIRMS_MAP_KEY]");
  return mensagem.replace(/https?:\/\/\S+/gi, "[URL]");
}

function filtrarJanelaFocos(focos, dias, agora = Date.now()) {
  const corte = agora - dias * 24 * 3600 * 1000;
  return focos.filter((f) => {
    const t = Date.parse(`${f.data}T${f.hora.slice(0, 2)}:${f.hora.slice(2)}:00Z`);
    return Number.isFinite(t) && t >= corte;
  });
}

async function buscarFocos(fonte, dias) {
  let url;
  if (MAP_KEY) {
    const area = `${BBOX.w},${BBOX.s},${BBOX.e},${BBOX.n}`;
    // A Area API conta em dias UTC: DAY_RANGE=1 devolve só o dia UTC de hoje (desde 00:00 UTC).
    // À noite em Cuiabá (UTC-4) já é o dia seguinte em UTC, então quase não há dados.
    // Por isso pedimos um dia a mais e cortamos pela hora real logo abaixo.
    url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${MAP_KEY}/${fonte}/${area}/${Math.min(dias + 1, 5)}`;
  } else {
    url = "https://firms.modaps.eosdis.nasa.gov/data/active_fire/" + ARQUIVOS_SEM_CHAVE[fonte];
  }
  let texto;
  try {
    const r = await fetch(url, { headers: { "User-Agent": "monitor-focos-mt" }, signal: AbortSignal.timeout(FIRMS_TIMEOUT_MS) });
    if (!r.ok) throw new Error(`FIRMS respondeu ${r.status}`);
    texto = await r.text(); // o mesmo sinal vale para o download do corpo
  } catch (e) {
    if (e?.name === "TimeoutError" || e?.name === "AbortError") throw new Error(`FIRMS não respondeu em ${Math.round(FIRMS_TIMEOUT_MS / 1000)} s`);
    throw e;
  }
  // Uma resposta válida sempre começa pelo cabeçalho do CSV. Qualquer outra coisa é erro ou página HTML.
  if (!texto.trimStart().toLowerCase().startsWith("latitude"))
    throw new Error("resposta inesperada da FIRMS: " + texto.trim().slice(0, 100).replace(/\s+/g, " "));
  // O leitor já descarta o que está fora do BBOX antes de criar os objetos (o arquivo sem chave cobre a América do Sul toda)
  let focos = parsearCsvFirms(texto, { fonte, satelite: NOME_FONTE[fonte] || fonte, bbox: BBOX });
  if (MAP_KEY) focos = filtrarJanelaFocos(focos, dias);
  return focos;
}

async function buscarVento(lat, lon) {
  const url =
    "https://api.open-meteo.com/v1/forecast?latitude=" + lat + "&longitude=" + lon +
    "&current=wind_speed_10m,wind_direction_10m,wind_gusts_10m,temperature_2m,relative_humidity_2m" +
    "&wind_speed_unit=kmh&timezone=auto";
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Open-Meteo respondeu ${r.status}`);
  const j = await r.json();
  const c = j.current || {};
  return {
    velocidadeKmh: c.wind_speed_10m,
    // Direção DE ONDE o vento sopra, em graus (0 = norte, 90 = leste)
    direcaoDeGraus: c.wind_direction_10m,
    rajadaKmh: c.wind_gusts_10m,
    temperatura: c.temperature_2m,
    umidade: c.relative_humidity_2m,
    horario: c.time,
  };
}

function sateliteGeo(satelite) {
  return /^(GOES|MSG)/i.test(satelite || "");
}

function eSomenteGeo(foco) {
  if (typeof foco.somenteGeo === "boolean") return foco.somenteGeo;
  const satelites = foco.satelites || (foco.satelite ? [foco.satelite] : []);
  return satelites.length > 0 && satelites.every(sateliteGeo);
}

function satelitesDoFoco(foco) {
  return foco.satelites || (foco.satelite ? [foco.satelite] : []);
}

// Junta detecções espaciais; para grupos com GOES/MSG usa a tolerância geo maior.
function mesclar(listas) {
  const CELULA = Math.max(DEDUP_KM, DEDUP_GEO_KM) / 100;
  const grade = new Map();
  const saida = [];
  const chave = (i, j) => i + ":" + j;
  for (const f of listas.flat()) {
    const i = Math.floor(f.lat / CELULA), j = Math.floor(f.lon / CELULA);
    const geoEntrada = eSomenteGeo(f);
    let alvo = null;
    for (let di = -1; di <= 1 && !alvo; di++) {
      for (let dj = -1; dj <= 1 && !alvo; dj++) {
        for (const g of grade.get(chave(i + di, j + dj)) || []) {
          const tolerancia = geoEntrada || g.somenteGeo ? DEDUP_GEO_KM : DEDUP_KM;
          if (geo.distanciaKm(f.lat, f.lon, g.lat, g.lon) <= tolerancia) { alvo = g; break; }
        }
      }
    }
    if (!alvo) {
      const satelites = [...new Set(satelitesDoFoco(f))];
      const varredurasGeo = [...new Set(f.varredurasGeo || [])];
      alvo = {
        ...f,
        lat: f.lat,
        lon: f.lon,
        frp: Number(f.frp) || 0,
        confianca: f.confianca,
        satelites,
        somenteGeo: geoEntrada,
        varredurasGeo,
        deteccoesGeo: varredurasGeo.length,
      };
      saida.push(alvo);
      const k = chave(i, j);
      if (!grade.has(k)) grade.set(k, []);
      grade.get(k).push(alvo);
    } else {
      for (const satelite of satelitesDoFoco(f)) {
        if (!alvo.satelites.includes(satelite)) alvo.satelites.push(satelite);
      }
      alvo.somenteGeo = alvo.somenteGeo && geoEntrada;
      for (const varredura of f.varredurasGeo || []) {
        if (!alvo.varredurasGeo.includes(varredura)) alvo.varredurasGeo.push(varredura);
      }
      alvo.deteccoesGeo = alvo.varredurasGeo.length;
      alvo.deteccoes = (alvo.deteccoes || 1) + (f.deteccoes || 1);
      if (ORDEM_CONF[f.confianca] > ORDEM_CONF[alvo.confianca]) alvo.confianca = f.confianca;
      if (f.frp > alvo.frp) alvo.frp = f.frp;
      if (f.data + f.hora > alvo.data + alvo.hora) { alvo.data = f.data; alvo.hora = f.hora; }
    }
  }
  for (const f of saida) {
    f.confirmacoes = f.satelites.filter((s) => !sateliteGeo(s)).length;
    f.deteccoesGeo = f.varredurasGeo.length;
  }
  return saida;
}

// A mescla de milhares de focos custa caro e dá o mesmo resultado enquanto as listas de cada satélite forem
// as mesmas (identidade do array no cache). Só é memorizada quando TODOS os satélites responderam; resultado
// parcial é refeito a cada chamada, para uma falha passageira não ficar grudada por 10 minutos.
const memoMescla = new Map();
async function buscarFocosPorFontes(dias, fontes = FONTES_FIRMS) {
  const chaves = fontes.map((s) => `focos:${s}:${dias}`);
  const resultados = await Promise.allSettled(
    fontes.map((s, i) => comCache(chaves[i], CACHE_MIN, () => buscarFocos(s, dias)))
  );
  resultados.forEach((r, i) => {
    if (r.status === "rejected") console.error(`FIRMS ${fontes[i]} falhou:`, sanitizarErro(r.reason));
  });
  const focosRecebidos = resultados.filter((r) => r.status === "fulfilled").map((r) => r.value);
  const completo = fontes.length > 0 && focosRecebidos.length === fontes.length;
  const chaveMemo = `${dias}:${fontes.join(",")}`;
  const memo = completo ? memoMescla.get(chaveMemo) : null;
  if (memo && memo.refs.every((ref, i) => ref === focosRecebidos[i])) return memo.resultado;
  const instantes = chaves.map((c) => cache.get(c)?.t).filter(Number.isFinite);
  const resultado = {
    focos: mesclar(focosRecebidos),
    erro: focosRecebidos.length === 0,
    // quando os dados foram de fato baixados (o mais antigo entre os satélites)
    atualizadoEm: instantes.length ? Math.min(...instantes) : Date.now(),
    fontes: fontes.map((fonte, i) => ({
      fonte,
      satelite: NOME_FONTE[fonte],
      total: resultados[i].status === "fulfilled" ? resultados[i].value.length : 0,
      erro: resultados[i].status === "rejected" ? sanitizarErro(resultados[i].reason) : null,
    })),
  };
  if (completo) memoMescla.set(chaveMemo, { refs: focosRecebidos, resultado });
  return resultado;
}

async function buscarFocosMesclados(dias) {
  const dados = await buscarFocosPorFontes(dias);
  if (dados.erro) throw new Error("nenhum satélite respondeu (veja os erros acima)");
  return dados.focos;
}

async function buscarDadosMonitor(dias) {
  const tarefas = [
    buscarFocosPorFontes(dias),
    MODO_INPE === "off"
      ? Promise.resolve([])
      : inpe.buscarFocosInpe({ janelaHoras: GEO_JANELA_HORAS, cacheMinutos: CACHE_GEO_MINUTOS, bbox: BBOX }),
  ];
  const [resultadoFirm, resultadoGeo] = await Promise.allSettled(tarefas);
  const focosFirm = resultadoFirm.status === "fulfilled" ? resultadoFirm.value.focos : [];
  let focosGeo = [];
  if (resultadoGeo.status === "fulfilled") focosGeo = mesclar([resultadoGeo.value]);
  else if (MODO_INPE !== "off") console.error("INPE: falha ao buscar focos:", sanitizarErro(resultadoGeo.reason));

  if (MODO_INPE === "observar") observadorGeo.atualizar(focosGeo, focosFirm);
  if (resultadoFirm.status === "rejected" || resultadoFirm.value.erro) {
    throw new Error("nenhum satélite respondeu (veja os erros acima)");
  }

  const focosGeoElegiveis = focosGeo.filter((f) =>
    !f.somenteGeo || f.deteccoesGeo >= GEO_MIN_DETECCOES
  );
  const focos = MODO_INPE === "on"
    ? mesclar([focosFirm, focosGeoElegiveis])
    : focosFirm;
  return { focosFirm, focosGeo, focosGeoElegiveis, focos };
}

async function ventoDaArea(a) {
  return comCache(`vento:${a.lat.toFixed(1)}:${a.lon.toFixed(1)}`, CACHE_MIN, () => buscarVento(a.lat, a.lon));
}

// ---------- monitor automático: roda em intervalo, sem depender da página aberta ----------
async function cicloMonitor() {
  if (!areas.length && MODO_INPE !== "observar") return;
  let dadosFocos;
  try { dadosFocos = await buscarDadosMonitor(1); }
  catch (e) { console.error("monitor: falha ao buscar focos:", sanitizarErro(e)); return; }
  const focos = focosParaAlerta(dadosFocos.focos);
  const focosElegiveisAlerta = focos.filter((f) => !f.somenteGeo || cfgAlerta.geoPodeAlertar);

  for (const a of areas) {
    let vento = null;
    try { vento = await ventoDaArea(a); }
    catch (e) { console.error(`monitor: falha no vento de ${a.nome}:`, sanitizarErro(e)); }

    const an = geo.analisarArea(a, focos, vento, cfgAlerta);
    const anEnvio = geo.analisarArea(a, focosElegiveisAlerta, vento, cfgAlerta);
    console.log(`monitor: ${a.nome} -> ${an.nivel} (${an.total} foco(s) ${AreaGeo.descreverAlcance(a)}; ${focos.length} no estado)`);
    const agora = Date.now();
    const isoAgora = new Date(agora).toISOString();
    const temEstadoAnterior = Object.hasOwn(estadoAlertas, a.id);
    const anterior = temEstadoAnterior ? estadoAlertas[a.id] : {};
    let nivelNotificado = anterior.nivelNotificado || anterior.nivel || "ok";
    const avisadosOriginais = Array.isArray(anterior.avisados) ? anterior.avisados.map((x) => ({ ...x })) : [];
    let avisados = avisadosOriginais.map((x) => ({ ...x }));
    const baseline = temEstadoAnterior && !Array.isArray(anterior.avisados);
    if (baseline) {
      avisados = an.dentro.map((x) => ({ lat: x.f.lat, lon: x.f.lon, km: x.km, t: isoAgora }));
      if (!anterior.nivelNotificado && !anterior.nivel) nivelNotificado = anEnvio.nivel;
    }
    const novos = [];
    if (!baseline) {
      for (const x of an.dentro) {
        const conhecido = avisados.find((v) => geo.distanciaKm(x.f.lat, x.f.lon, v.lat, v.lon) <= DEDUP_KM);
        if (conhecido) {
          conhecido.t = isoAgora;
          conhecido.km = x.km;
        } else {
          novos.push(x);
        }
      }
      const limiteAntigo = agora - 48 * 60 * 60 * 1000;
      avisados = avisados.filter((v) => Date.parse(v.t) >= limiteAntigo);
      if (avisados.length > 500) avisados = avisados.slice(-500);
    }
    const subiu = ORDEM_NIVEL[anEnvio.nivel] > ORDEM_NIVEL[nivelNotificado];
    const geoElegivelAlerta = (x) => !x.f.somenteGeo || cfgAlerta.geoPodeAlertar;
    const novosPerto = novos.filter((x) => geoElegivelAlerta(x) && x.km <= cfgAlerta.distAlertaKm);
    const novosAFavor = novos.filter((x) => geoElegivelAlerta(x) && x.aFavor && x.km <= cfgAlerta.ventoMaxKm);
    const limiteAntigo = agora - 48 * 60 * 60 * 1000;
    const distanciasAnteriores = avisadosOriginais
      .filter((x) => Date.parse(x.t) >= limiteAntigo)
      .map((x) => x.km)
      .filter(Number.isFinite);
    const menorAnterior = distanciasAnteriores.length ? Math.min(...distanciasAnteriores) : null;
    const aproximou = avisados.length > 0 && menorAnterior != null
      && novos.some((x) => geoElegivelAlerta(x) && x.km <= menorAnterior - APROX_MARGEM_KM);
    const motivos = [];
    if (subiu) motivos.push(`Nível subiu para ${anEnvio.nivel === "alto" ? "Alerta" : anEnvio.nivel === "atencao" ? "Atenção" : "Sem focos"}`);
    if (novosPerto.length) motivos.push(`Novo foco a ${novosPerto[0].km.toFixed(1)} km, a ${geo.nomePonto(novosPerto[0].rumo)}`);
    if (novosAFavor.length) motivos.push(`Novo foco a favor do vento a ${novosAFavor[0].km.toFixed(1)} km`);
    if (aproximou) motivos.push("Foco mais próximo que os anteriores");
    const url = a.webhookUrl || WEBHOOK_URL_PADRAO;
    let falhaPrimeiraLeitura = false;
    let melhoraDesde = Number.isFinite(Date.parse(anterior.melhoraDesde || ""))
      ? anterior.melhoraDesde : null;
    const melhorou = ORDEM_NIVEL[anEnvio.nivel] < ORDEM_NIVEL[nivelNotificado];
    if (melhorou) {
      melhoraDesde ||= isoAgora;
      const melhoraMadura = agora - Date.parse(melhoraDesde) >= MELHORA_MINUTOS * 60000;
      if (melhoraMadura && !melhoraCoberta(nivelNotificado)) {
        nivelNotificado = anEnvio.nivel;
        melhoraDesde = null;
      } else if (melhoraMadura && url) {
        const causa = an.total ? "focos_no_raio" : "focos_antigos";
        const motivoMelhora = causa === "focos_no_raio"
          ? "Focos continuam no raio, mas já não estão a favor do vento"
          : "Nenhum foco detectado nas últimas 24 h";
        try {
          const png = await gerarImagemArea(a, focos, vento, an);
          await enviarWebhook({ ...a, webhookUrl: url }, an, vento, png, motivoMelhora, "melhora", causa);
          nivelNotificado = anEnvio.nivel;
          melhoraDesde = null;
          anterior.ultimoEnvio = isoAgora;
          avisados = an.dentro.map((x) => ({ lat: x.f.lat, lon: x.f.lon, km: x.km, t: isoAgora }));
          console.log(`webhook de melhora enviado: ${a.nome} (${an.nivel})`);
        } catch (e) {
          avisados = avisadosOriginais;
          console.error(`webhook de melhora falhou para ${a.nome}:`, sanitizarErro(e));
        }
      }
    } else {
      melhoraDesde = null;
      const primeiraLeitura = !temEstadoAnterior && anEnvio.nivel !== "ok"
        && ORDEM_NIVEL[anEnvio.nivel] >= ORDEM_NIVEL[WEBHOOK_NIVEL_MINIMO];
      const motivoPrioritario = primeiraLeitura
        ? "Primeira leitura da área"
        : subiu
        ? motivos[0]
        : novosPerto.length
          ? motivos.find((x) => x.startsWith("Novo foco a "))
          : novosAFavor.length
            ? motivos.find((x) => x.startsWith("Novo foco a favor"))
            : aproximou
              ? "Foco mais próximo que os anteriores"
              : null;
      const ultimoEnvio = Date.parse(anterior.ultimoEnvio || "");
      const intervaloOk = !Number.isFinite(ultimoEnvio) || agora - ultimoEnvio >= ENVIO_INTERVALO_MIN * 60000;
      const podeEnviar = url && motivoPrioritario
        && ORDEM_NIVEL[anEnvio.nivel] >= ORDEM_NIVEL[WEBHOOK_NIVEL_MINIMO]
        && (intervaloOk || novosPerto.length > 0 || (subiu && an.nivel === "alto"));
      if (podeEnviar) {
        try {
          const png = await gerarImagemArea(a, focos, vento, an);
          await enviarWebhook({ ...a, webhookUrl: url }, an, vento, png, motivoPrioritario);
          nivelNotificado = anEnvio.nivel;
          anterior.ultimoEnvio = isoAgora;
          avisados = an.dentro.map((x) => ({ lat: x.f.lat, lon: x.f.lon, km: x.km, t: isoAgora }));
          console.log(`webhook enviado: ${a.nome} (${an.nivel})`);
        } catch (e) {
          avisados = avisadosOriginais;
          falhaPrimeiraLeitura = primeiraLeitura;
          console.error(`webhook falhou para ${a.nome}:`, sanitizarErro(e));
        }
      }
    }
    if (!falhaPrimeiraLeitura) {
      estadoAlertas[a.id] = {
        nivel: anEnvio.nivel,
        em: isoAgora,
        nivelNotificado,
        avisados: avisados.slice(-500),
        ...(melhoraDesde ? { melhoraDesde } : {}),
        ...(anterior.ultimoEnvio ? { ultimoEnvio: anterior.ultimoEnvio } : {}),
      };
    }
  }
  armazenamento.salvarEstado(estadoAlertas);
}

function json(res, status, obj) {
  enviarBufferPequeno(res, status, "application/json; charset=utf-8", Buffer.from(JSON.stringify(obj)));
}

const TIPOS = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml" };
const COMPRIMIVEIS = new Set([".html", ".js", ".css", ".json", ".svg"]);

function lerCorpoJSON(req, limite = 1e6) {
  return new Promise((resolve, reject) => {
    let dados = "";
    req.on("data", (c) => { dados += c; if (dados.length > limite) req.destroy(); });
    req.on("end", () => { try { resolve(dados ? JSON.parse(dados) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

function erroArea(lat, lon, raio) {
  if (!Number.isFinite(lat) || lat < BBOX.s || lat > BBOX.n || !Number.isFinite(lon) || lon < BBOX.w || lon > BBOX.e)
    return `latitude e longitude devem estar dentro da área monitorada (${NOME_REGIAO})`;
  if (!Number.isFinite(raio) || raio <= 0 || raio > 500)
    return "o raio deve ser maior que 0 e no máximo 500 km";
  return null;
}

function areaPublica(area, nivelAtual = null) {
  return {
    id: area.id,
    nome: area.nome,
    lat: area.lat,
    lon: area.lon,
    raio: area.raio,
    ...(AreaGeo.ehImovel(area) ? { tipo: "imovel", folga: area.folga, hectares: area.hectares, partes: area.partes } : { tipo: "circulo" }),
    webhookConfigurado: Boolean(area.webhookUrl),
    nivelAtual,
  };
}

// ---------- resposta de /api/focos: recorte, teto e formato enxuto ----------
const focoConfirmado = (f) => f.confirmacoes >= 2 && !f.somenteGeo;

function janelasDasAreas(lista) {
  // pré-filtro retangular (um pouco generoso) para não calcular haversine contra todas as áreas
  return lista.map((a) => {
    const dLat = a.raio / 110;
    const dLon = a.raio / (110 * Math.max(0.05, Math.cos((a.lat * Math.PI) / 180)));
    return { lat: a.lat, lon: a.lon, raio: a.raio, s: a.lat - dLat, n: a.lat + dLat, w: a.lon - dLon, e: a.lon + dLon };
  });
}

function dentroDeAlgumaArea(f, janelas) {
  for (const j of janelas) {
    if (f.lat < j.s || f.lat > j.n || f.lon < j.w || f.lon > j.e) continue;
    if (geo.distanciaKm(j.lat, j.lon, f.lat, f.lon) <= j.raio) return true;
  }
  return false;
}

// confirmados primeiro, depois maior potência, depois mais recentes
function porPrioridade(a, b) {
  const c = Number(focoConfirmado(b)) - Number(focoConfirmado(a));
  if (c) return c;
  if (b.frp !== a.frp) return b.frp - a.frp;
  const ta = a.data + a.hora, tb = b.data + b.hora;
  return ta < tb ? 1 : ta > tb ? -1 : 0;
}

/**
 * Decide o que vai para a página. A página refaz a análise das áreas com os focos que recebe, então:
 *  - foco dentro do círculo de qualquer área monitorada SEMPRE é enviado (mesmo fora da região ou acima do teto);
 *  - os demais precisam estar dentro da região (polígono);
 *  - se ainda passar do teto, ficam os de maior prioridade.
 */
function reduzirParaCliente(focos, listaAreas, { regiaoAtiva = regiao, teto = MAX_FOCOS_RESPOSTA } = {}) {
  const janelas = janelasDasAreas(listaAreas);
  const protegidos = [];
  let demais = [];
  let foraDaRegiao = 0;
  for (const f of focos) {
    if (janelas.length && dentroDeAlgumaArea(f, janelas)) protegidos.push(f);
    else if (!regiaoAtiva || regiaoAtiva.contem(f.lat, f.lon)) demais.push(f);
    else foraDaRegiao++;
  }
  let omitidos = 0;
  if (teto > 0 && protegidos.length + demais.length > teto) {
    demais.sort(porPrioridade);
    const cabe = Math.max(0, teto - protegidos.length);
    omitidos = demais.length - cabe;
    demais = demais.slice(0, cabe);
  }
  return { focos: protegidos.length ? protegidos.concat(demais) : demais, foraDaRegiao, omitidos };
}

// Só os campos que a página lê (fonte, satelite, varredurasGeo, deteccoesGeo e deteccoes ficam no servidor).
function focoParaCliente(f) {
  return {
    lat: f.lat, lon: f.lon, data: f.data, hora: f.hora, frp: f.frp, confianca: f.confianca,
    satelites: f.satelites || (f.satelite ? [f.satelite] : []),
    confirmacoes: f.confirmacoes || 0,
    somenteGeo: !!f.somenteGeo,
  };
}

function assinaturaAreas() {
  const resumo = areas.map((a) => [a.id, a.lat, a.lon, a.raio, a.folga || "", a.partes ? JSON.stringify(a.partes).length : ""].join(":")).join("|");
  return crypto.createHash("sha1").update(resumo).digest("hex");
}

const respostasFocos = new Map(); // "fonte:dias" -> { dadosFirm, sig, corpo }
const CORPO_REGIAO = new CorpoComprimivel(Buffer.from(JSON.stringify(GEOJSON_REGIAO)), "application/geo+json; charset=utf-8");

async function montarCorpoFocos(fonte, dias, dadosFirm) {
  const fontes = [...dadosFirm.fontes];
  let focosGeo = [];
  if (MODO_INPE !== "off") {
    try {
      const focosBrutos = await inpe.buscarFocosInpe({
        janelaHoras: GEO_JANELA_HORAS,
        cacheMinutos: CACHE_GEO_MINUTOS,
        bbox: BBOX,
      });
      focosGeo = mesclar([focosBrutos]);
      fontes.push({ fonte: "INPE_GEO", satelite: "INPE (GOES/MSG)", total: focosBrutos.length, erro: null, modo: MODO_INPE });
    } catch (e) {
      const erroGeo = sanitizarErro(e);
      console.error("INPE: falha ao buscar focos:", erroGeo);
      fontes.push({ fonte: "INPE_GEO", satelite: "INPE (GOES/MSG)", total: 0, erro: erroGeo, modo: MODO_INPE });
    }
  } else {
    fontes.push({ fonte: "INPE_GEO", satelite: "INPE (GOES/MSG)", total: 0, erro: null, modo: "off" });
  }
  const focosGeoElegiveis = focosGeo.filter((f) => !f.somenteGeo || f.deteccoesGeo >= GEO_MIN_DETECCOES);
  let focos = dadosFirm.focos;
  if (fonte === "INPE_GEO") {
    focos = MODO_INPE === "observar" ? [] : focosGeoElegiveis;
  } else if (fonte === "todos" && MODO_INPE === "on") {
    focos = mesclar([dadosFirm.focos, focosGeoElegiveis]);
  }
  const reduzido = reduzirParaCliente(focos, areas);
  const corpo = {
    fonte, dias,
    atualizadoEm: new Date(dadosFirm.atualizadoEm).toISOString(),
    total: reduzido.focos.length,
    foraDaRegiao: reduzido.foraDaRegiao,
    omitidos: reduzido.omitidos,
    fontes,
    focos: reduzido.focos.map(focoParaCliente),
  };
  return new CorpoComprimivel(Buffer.from(JSON.stringify(corpo)), "application/json; charset=utf-8");
}

// Arquivos de public/ ficam em memória (já comprimidos) enquanto não mudarem no disco.
const PASTA_PUBLICA = path.join(__dirname, "public");
const estaticos = new Map(); // caminho -> { mtimeMs, size, corpo }
async function servirEstatico(req, res, arq) {
  let st;
  try { st = await fs.promises.stat(arq); } catch { return json(res, 404, { erro: "não encontrado" }); }
  if (!st.isFile()) return json(res, 404, { erro: "não encontrado" });
  let e = estaticos.get(arq);
  if (!e || e.mtimeMs !== st.mtimeMs || e.size !== st.size) {
    const dados = await fs.promises.readFile(arq);
    const ext = path.extname(arq);
    e = { mtimeMs: st.mtimeMs, size: st.size, comprimivel: COMPRIMIVEIS.has(ext), corpo: new CorpoComprimivel(dados, TIPOS[ext] || "application/octet-stream") };
    estaticos.set(arq, e);
  }
  // revalida a cada carga (o ETag evita rebaixar o app.js/style.css quando não mudaram); imagens já vêm comprimidas
  return enviarCorpo(req, res, e.corpo, { cacheControl: "no-cache", comprimir: e.comprimivel });
}

const servidor = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  try {
    if (u.pathname === "/api/saude") {
      return json(res, 200, {
        ok: true,
        modo: MAP_KEY ? "api com MAP_KEY" : "arquivos sem chave (24h)",
        monitor: areas.length ? `rodando a cada ${MONITOR_MIN} min, ${areas.length} área(s)` : "sem áreas cadastradas",
        webhookPadrao: WEBHOOK_URL_PADRAO ? "configurado" : "não configurado",
        regiao: NOME_REGIAO,
      });
    }
    if (u.pathname === "/api/regiao" && (req.method === "GET" || req.method === "HEAD")) {
      return await enviarCorpo(req, res, CORPO_REGIAO, { cacheControl: "no-cache" });
    }
    if (u.pathname === "/api/config" && req.method === "GET") {
      return json(res, 200, {
        ...cfgAlerta,
        confiancaMinima: CONFIANCA_MINIMA,
        emergencia: "193",
        regiao: { nome: NOME_REGIAO, bbox: BBOX },
        inpeGeo: MODO_INPE,
        geoMinDeteccoes: GEO_MIN_DETECCOES,
      });
    }

    // ---------- áreas monitoradas (guardadas no servidor; o monitor automático usa esta lista) ----------
    if (u.pathname === "/api/areas" && req.method === "GET") {
      return json(res, 200, areas.map((a) => areaPublica(a, estadoAlertas[a.id]?.nivel || null)));
    }
    if (u.pathname === "/api/areas" && req.method === "POST") {
      const b = await lerCorpoJSON(req, 4e6);
      let geometria;
      if (b.partes != null) { // imóvel (shapefile) + folga
        if (!String(b.nome || "").trim()) return json(res, 400, { erro: "informe o nome do imóvel" });
        const f = validarFolga(b.folga);
        if (f.erro) return json(res, 400, { erro: f.erro });
        const im = prepararImovel(b.partes, f.folga, BBOX);
        if (im.erro) return json(res, 400, { erro: im.erro });
        geometria = { lat: im.lat, lon: im.lon, raio: im.raio, folga: f.folga, hectares: Math.round(im.hectares * 10) / 10, partes: im.partes };
      } else {
        const lat = Number(b.lat), lon = Number(b.lon), raio = Number(b.raio);
        if (!String(b.nome || "").trim())
          return json(res, 400, { erro: "nome, lat, lon e raio são obrigatórios" });
        const erro = erroArea(lat, lon, raio);
        if (erro) return json(res, 400, { erro });
        geometria = { lat, lon, raio };
      }
      const area = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        nome: String(b.nome).trim(), ...geometria,
        webhookUrl: b.webhookUrl ? String(b.webhookUrl).trim() : "",
      };
      areas.push(area);
      armazenamento.salvarAreas(areas);
      return json(res, 201, areaPublica(area));
    }
    const mArea = u.pathname.match(/^\/api\/areas\/([^/]+)$/);
    if (mArea && req.method === "PATCH") {
      const a = areas.find((x) => x.id === mArea[1]);
      if (!a) return json(res, 404, { erro: "área não encontrada" });
      const b = await lerCorpoJSON(req);
      if (b.nome != null && !String(b.nome).trim()) return json(res, 400, { erro: "o nome da área não pode ficar vazio" });
      if (AreaGeo.ehImovel(a)) {
        // imóvel: só a folga muda (lat/lon/raio vêm do polígono); para trocar o polígono, cadastre de novo
        if (b.folga != null) {
          const f = validarFolga(b.folga);
          if (f.erro) return json(res, 400, { erro: f.erro });
          const im = prepararImovel(a.partes, f.folga, BBOX);
          if (im.erro) return json(res, 400, { erro: im.erro });
          a.folga = f.folga;
          a.raio = im.raio;
        }
      } else {
        const lat = b.lat == null ? a.lat : Number(b.lat);
        const lon = b.lon == null ? a.lon : Number(b.lon);
        const raio = b.raio == null ? a.raio : Number(b.raio);
        const erro = erroArea(lat, lon, raio);
        if (erro) return json(res, 400, { erro });
        a.lat = lat;
        a.lon = lon;
        a.raio = raio;
      }
      if (b.nome != null) a.nome = String(b.nome).trim();
      if (b.webhookUrl != null) a.webhookUrl = String(b.webhookUrl).trim();
      armazenamento.salvarAreas(areas);
      return json(res, 200, areaPublica(a, estadoAlertas[a.id]?.nivel || null));
    }
    if (mArea && req.method === "DELETE") {
      areas = areas.filter((a) => a.id !== mArea[1]);
      delete estadoAlertas[mArea[1]];
      armazenamento.salvarAreas(areas);
      armazenamento.salvarEstado(estadoAlertas);
      return json(res, 200, { ok: true });
    }

    // imagem pronta da área, para conferir como fica antes de configurar o webhook
    const mImagem = u.pathname.match(/^\/api\/areas\/([^/]+)\/imagem$/);
    if (mImagem) {
      const a = areas.find((x) => x.id === mImagem[1]);
      if (!a) return json(res, 404, { erro: "área não encontrada" });
      const focos = focosParaAlerta(await buscarFocosMesclados(1));
      let vento = null;
      try { vento = await ventoDaArea(a); }
      catch (e) { console.error(`imagem: falha no vento de ${a.nome}:`, sanitizarErro(e)); }
      const an = geo.analisarArea(a, focos, vento, cfgAlerta);
      const png = await gerarImagemArea(a, focos, vento, an);
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
      return res.end(png);
    }

    // dispara o webhook agora, do jeito que a área está, para testar a integração
    const mTeste = u.pathname.match(/^\/api\/areas\/([^/]+)\/testar-webhook$/);
    if (mTeste && req.method === "POST") {
      const a = areas.find((x) => x.id === mTeste[1]);
      if (!a) return json(res, 404, { erro: "área não encontrada" });
      const url = a.webhookUrl || WEBHOOK_URL_PADRAO;
      if (!url) return json(res, 400, { erro: "nenhum webhook configurado (nem na área, nem em WEBHOOK_URL no .env)" });
      const focos = focosParaAlerta(await buscarFocosMesclados(1));
      let vento = null;
      try { vento = await ventoDaArea(a); }
      catch (e) { console.error(`teste webhook: falha no vento de ${a.nome}:`, sanitizarErro(e)); }
      const an = geo.analisarArea(a, focos, vento, cfgAlerta);
      const png = await gerarImagemArea(a, focos, vento, an);
      await enviarWebhook({ ...a, webhookUrl: url }, an, vento, png, "Teste manual do webhook");
      return json(res, 200, { enviado: true, nivel: an.nivel });
    }

    if (u.pathname === "/api/focos") {
      const pedida = u.searchParams.get("fonte");
      const fonte = FONTES_FIRMS.includes(pedida) || pedida === "INPE_GEO" ? pedida : "todos";
      const dias = MAP_KEY ? Math.min(5, Math.max(1, Number(u.searchParams.get("dias")) || 1)) : 1;
      const lista = fonte === "todos" ? FONTES_FIRMS : FONTES_FIRMS.includes(fonte) ? [fonte] : [];
      const dadosFirm = await buscarFocosPorFontes(dias, lista);
      if (dadosFirm.erro && fonte !== "INPE_GEO") throw new Error("nenhum satélite respondeu (veja os erros acima)");
      // Enquanto os dados dos satélites e as áreas forem os mesmos, a resposta (já comprimida) é reaproveitada.
      // Com o INPE ligado os dados geoestacionários mudam a cada consulta, então nada é reaproveitado.
      const chave = `${fonte}:${dias}`;
      const sig = assinaturaAreas();
      const guardada = MODO_INPE === "off" ? respostasFocos.get(chave) : null;
      let corpo;
      if (guardada && guardada.dadosFirm === dadosFirm && guardada.sig === sig) {
        corpo = guardada.corpo;
      } else {
        corpo = await montarCorpoFocos(fonte, dias, dadosFirm);
        if (MODO_INPE === "off") respostasFocos.set(chave, { dadosFirm, sig, corpo });
      }
      return await enviarCorpo(req, res, corpo, { cacheControl: "no-cache" });
    }
    if (u.pathname === "/api/vento") {
      const lat = Number(u.searchParams.get("lat"));
      const lon = Number(u.searchParams.get("lon"));
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return json(res, 400, { erro: "lat e lon inválidos" });
      const chave = `vento:${lat.toFixed(1)}:${lon.toFixed(1)}`;
      return json(res, 200, await comCache(chave, CACHE_MIN, () => buscarVento(lat, lon)));
    }
    // arquivos estáticos
    const rel = u.pathname === "/" ? "index.html" : u.pathname.replace(/^\/+/, "");
    const arq = path.join(PASTA_PUBLICA, path.normalize(rel));
    if (!arq.startsWith(PASTA_PUBLICA + path.sep)) return json(res, 403, { erro: "negado" });
    return await servirEstatico(req, res, arq);
  } catch (e) {
    json(res, 502, { erro: sanitizarErro(e) });
  }
});

function iniciar() {
  servidor.listen(PORT, HOST, () => {
    console.log(`Monitor de focos (${NOME_REGIAO}) em http://${HOST}:${PORT}`);
    if (HOST !== "127.0.0.1" && HOST !== "localhost" && HOST !== "::1")
      console.log("Atenção: o servidor não tem autenticação. Proteja-o com um proxy com senha ou VPN antes de expô-lo.");
    console.log(MAP_KEY ? "Usando a API da FIRMS com MAP_KEY." : "Sem FIRMS_MAP_KEY: usando arquivos públicos das últimas 24h.");
    console.log(WEBHOOK_URL_PADRAO ? "Webhook padrão configurado em .env." : "Nenhum webhook padrão em .env (pode ser definido por área, no painel).");
    cicloMonitor();
    setInterval(cicloMonitor, MONITOR_MIN * 60000);
  });
}

if (require.main === module) iniciar();

module.exports = {
  iniciar, servidor, cicloMonitor, mesclar, buscarFocos, buscarFocosMesclados,
  focosParaAlerta, filtrarJanelaFocos, erroArea, cfgAlerta, CONFIANCA_MINIMA, FONTES_FIRMS,
  reduzirParaCliente, focoParaCliente, BBOX, regiao, comCache,
  __test: {
    setAreas(novasAreas) { areas = novasAreas; },
    setEstado(novoEstado) { estadoAlertas = novoEstado; },
    getEstado() { return estadoAlertas; },
    getModoInpe() { return MODO_INPE; },
    setModoInpe(modo) {
      if (!["off", "observar", "on"].includes(modo)) throw new Error("modo INPE inválido");
      MODO_INPE = modo;
      inpe.limparCache();
    },
    setGeoPodeAlertar(valor) { cfgAlerta.geoPodeAlertar = Boolean(valor); },
    melhoraCoberta,
    melhoraMinutos: MELHORA_MINUTOS,
    getPoliticaMelhora() { return AVISAR_MELHORA; },
    setPoliticaMelhora(politica) {
      if (!["todos", "apos_alerta", "nunca"].includes(politica)) throw new Error("política de melhora inválida");
      AVISAR_MELHORA = politica;
    },
    limparCache() { cache.clear(); emAndamento.clear(); memoMescla.clear(); respostasFocos.clear(); estaticos.clear(); inpe.limparCache(); },
    setTimeoutFirmsMs(ms) { FIRMS_TIMEOUT_MS = ms; },
    armazenamento,
  },
};