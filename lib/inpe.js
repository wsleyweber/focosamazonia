const PASTA = "https://dataserver-coids.inpe.br/queimadas/queimadas/focos/csv/10min/";
const AGENTE = "monitor-focos-mt/1.0 (fonte INPE Queimadas)";
const NOMES_ARQUIVOS = /href=["'](focos_10min_\d{8}_\d{4}\.csv)["']/gi;
const cacheArquivos = new Map();
const satelitesDescartados = new Set();
let cacheListagem = null;

function dataArquivo(nome) {
  const m = nome.match(/^focos_10min_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})\.csv$/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : NaN;
}

function selecionarArquivos(html, janelaHoras, agora = Date.now()) {
  const nomes = [...html.matchAll(NOMES_ARQUIVOS)].map((m) => m[1]);
  if (!nomes.length) throw new Error("listagem do INPE não contém nomes de arquivos focos_10min_*.csv");
  const corte = agora - janelaHoras * 60 * 60 * 1000;
  return [...new Set(nomes)]
    .filter((nome) => dataArquivo(nome) >= corte && dataArquivo(nome) <= agora)
    .sort((a, b) => dataArquivo(a) - dataArquivo(b));
}

function parsearCsv(texto) {
  const linhas = texto.replace(/^\uFEFF/, "").trim().split(/\r?\n/);
  if (!linhas.length || linhas[0].trim().toLowerCase() !== "lat,lon,satelite,data") {
    throw new Error("cabeçalho inesperado no CSV do INPE");
  }
  const focos = [];
  for (const linha of linhas.slice(1)) {
    if (!linha.trim()) continue;
    const campos = linha.split(",");
    if (campos.length !== 4) continue;
    const [latTexto, lonTexto, sateliteTexto, dataTexto] = campos.map((x) => x.trim());
    const satelite = sateliteTexto.trim();
    if (!/^(GOES|MSG)/i.test(satelite)) {
      if (satelite && !satelitesDescartados.has(satelite)) {
        satelitesDescartados.add(satelite);
        console.warn(`INPE: satélite descartado por não ser geoestacionário: ${satelite}`);
      }
      continue;
    }
    const instante = dataTexto.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
    const lat = Number.parseFloat(latTexto.trim());
    const lon = Number.parseFloat(lonTexto.trim());
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !instante) continue;
    const data = instante[1];
    const hora = `${instante[2]}${instante[3]}`;
    // O CSV não informa fuso: adotamos UTC, pendente de validação com uma FIRMS simultânea.
    if (!Number.isFinite(Date.parse(`${data}T${instante[2]}:${instante[3]}:${instante[4]}Z`))) continue;
    focos.push({
      lat, lon, data, hora, frp: 0, confianca: "nominal",
      fonte: "INPE_GEO", satelite, varredurasGeo: [`${data}T${instante[2]}:${instante[3]}:${instante[4]}Z`],
    });
  }
  return focos;
}

function filtrarBbox(focos, bbox) {
  return focos.filter((f) =>
    f.lon >= bbox.w && f.lon <= bbox.e && f.lat >= bbox.s && f.lat <= bbox.n
  );
}

async function obterListagem(cacheMinutos) {
  const agora = Date.now();
  if (cacheListagem && agora - cacheListagem.em < cacheMinutos * 60000) return cacheListagem.html;
  const resposta = await fetch(PASTA, { headers: { "User-Agent": AGENTE } });
  if (!resposta.ok) throw new Error(`listagem do INPE respondeu ${resposta.status}`);
  const html = await resposta.text();
  cacheListagem = { em: agora, html };
  return html;
}

async function buscarFocosInpe({ janelaHoras, cacheMinutos, bbox }) {
  const html = await obterListagem(cacheMinutos);
  const agora = Date.now();
  const nomes = selecionarArquivos(html, janelaHoras, agora);
  const corte = agora - janelaHoras * 60 * 60 * 1000;
  for (const [nome] of cacheArquivos) {
    if (dataArquivo(nome) < corte) cacheArquivos.delete(nome);
  }
  const resultados = await Promise.allSettled(nomes.map(async (nome) => {
    if (!cacheArquivos.has(nome)) {
      const resposta = await fetch(PASTA + nome, { headers: { "User-Agent": AGENTE } });
      if (!resposta.ok) throw new Error(`arquivo do INPE ${nome} respondeu ${resposta.status}`);
      cacheArquivos.set(nome, parsearCsv(await resposta.text()));
    }
    return cacheArquivos.get(nome);
  }));
  const validos = resultados.filter((r) => r.status === "fulfilled");
  resultados.forEach((r) => {
    if (r.status === "rejected") console.error(`INPE: ${r.reason.message || r.reason}`);
  });
  if (!validos.length && nomes.length) throw new Error("nenhum arquivo recente do INPE pôde ser lido");
  return filtrarBbox(validos.flatMap((r) => r.value), bbox);
}

function limparCache() {
  cacheArquivos.clear();
  cacheListagem = null;
}

module.exports = { buscarFocosInpe, parsearCsv, filtrarBbox, selecionarArquivos, limparCache };
