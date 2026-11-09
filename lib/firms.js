// Leitura do CSV da NASA FIRMS. Os arquivos de região inteira (América do Sul, 24 h) e as respostas da
// Area API podem ter centenas de milhares de linhas; por isso este leitor extrai só as colunas usadas e
// descarta a linha pelo retângulo ANTES de alocar qualquer coisa (a versão anterior criava um objeto com
// as 14 colunas para cada linha e só filtrava depois).

// VIIRS informa l/n/h; MODIS informa 0-100. Unifica em baixa / nominal / alta.
function nivelConfianca(c) {
  const t = String(c || "").trim().toLowerCase();
  if (t === "l" || t === "low") return "baixa";
  if (t === "h" || t === "high") return "alta";
  if (t === "n" || t === "nominal") return "nominal";
  const n = parseFloat(t);
  if (Number.isFinite(n)) return n >= 80 ? "alta" : n >= 30 ? "nominal" : "baixa";
  return "nominal";
}

const COLUNAS = ["latitude", "longitude", "acq_date", "acq_time", "confidence", "frp"];

/**
 * @param {string} texto CSV completo, já validado (começa pelo cabeçalho)
 * @param {{fonte:string, satelite?:string, bbox?:{w:number,s:number,e:number,n:number}}} opcoes
 * @returns {Array} focos normalizados: { lat, lon, data, hora(HHMM UTC), frp, confianca, fonte, satelite }
 */
function parsearCsvFirms(texto, { fonte, satelite = fonte, bbox = null }) {
  const inicio = texto.search(/\S/);
  if (inicio < 0) return [];
  const fimCab = texto.indexOf("\n", inicio);
  if (fimCab < 0) return [];
  const cabecalho = texto.slice(inicio, fimCab).replace(/\r$/, "").split(",").map((c) => c.trim().toLowerCase());
  const idx = Object.fromEntries(COLUNAS.map((c) => [c, cabecalho.indexOf(c)]));
  if (idx.latitude < 0 || idx.longitude < 0) return [];
  const campos = COLUNAS.map((c) => ({ nome: c, i: idx[c] })).filter((c) => c.i >= 0).sort((a, b) => a.i - b.i);
  const ultimo = campos[campos.length - 1].i;
  // depois de ler lat e lon (as duas primeiras colunas na prática) já dá para descartar a linha
  const apos = Math.max(idx.latitude, idx.longitude);
  const focos = [];
  const valores = {};
  let pos = fimCab + 1;
  const tam = texto.length;
  while (pos < tam) {
    let fim = texto.indexOf("\n", pos);
    if (fim < 0) fim = tam;
    const linhaIni = pos;
    pos = fim + 1;
    if (texto.charCodeAt(fim - 1) === 13) fim--; // \r
    if (fim <= linhaIni) continue;
    // percorre as colunas só até a última necessária; linha curta deixa campos undefined (e cai fora abaixo)
    let cursor = linhaIni, coluna = 0, k = 0, descartar = false;
    valores.latitude = valores.longitude = valores.acq_date = valores.acq_time = valores.confidence = valores.frp = undefined;
    while (coluna <= ultimo) {
      let virgula = texto.indexOf(",", cursor);
      if (virgula < 0 || virgula > fim) virgula = fim;
      if (coluna === campos[k].i) {
        valores[campos[k].nome] = texto.slice(cursor, virgula);
        k++;
        if (bbox && coluna === apos) {
          const lat = parseFloat(valores.latitude), lon = parseFloat(valores.longitude);
          if (!(lon >= bbox.w && lon <= bbox.e && lat >= bbox.s && lat <= bbox.n)) { descartar = true; break; }
        }
      }
      if (virgula >= fim) break;
      cursor = virgula + 1;
      coluna++;
    }
    if (descartar) continue;
    const lat = parseFloat(valores.latitude), lon = parseFloat(valores.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (bbox && !(lon >= bbox.w && lon <= bbox.e && lat >= bbox.s && lat <= bbox.n)) continue;
    focos.push({
      lat,
      lon,
      data: valores.acq_date,
      hora: (valores.acq_time || "").padStart(4, "0"), // HHMM em UTC
      frp: parseFloat(valores.frp) || 0,
      confianca: nivelConfianca(valores.confidence),
      fonte,
      satelite,
    });
  }
  return focos;
}

module.exports = { nivelConfianca, parsearCsvFirms };
