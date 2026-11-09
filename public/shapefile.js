// Leitor de shapefile de polígonos (imóvel rural), sem dependências: roda no navegador e em Node.
// Lê .shp (obrigatório), .prj (sistema de coordenadas), .dbf (nome sugerido) e arquivos .zip com esses três.
// Saída: { partes: [{ aneis: [[[lon,lat],...], ...] }], ... } em graus, o formato que lib/geo.js e AreaGeo usam.
//
// Sistemas de coordenadas aceitos:
//  - graus (SIRGAS 2000, WGS 84, SAD 69 geográfico...): usado como está. SIRGAS 2000 e WGS 84 diferem em < 1 m;
//    outros datums podem deslocar a posição em dezenas de metros (vira aviso, não erro).
//  - UTM / Transversa de Mercator em metros (lido do .prj): convertido para graus.
//  - sem .prj: se os valores parecem graus, assume graus; senão pede o .prj.
(function (raiz) {
  const RAD = Math.PI / 180;
  const TIPOS_POLIGONO = new Set([5, 15, 25, 31]); // Polygon, PolygonZ, PolygonM, MultiPatch (só o desenho plano)

  // ---------- .shp ----------
  function lerShp(buffer) {
    const dv = new DataView(buffer instanceof ArrayBuffer ? buffer : buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
    if (dv.byteLength < 100 || dv.getInt32(0, false) !== 9994) throw new Error("o arquivo .shp não é um shapefile válido");
    const tipoArquivo = dv.getInt32(32, true);
    if (!TIPOS_POLIGONO.has(tipoArquivo)) {
      throw new Error(`o shapefile precisa ser de polígonos (o arquivo é do tipo ${tipoArquivo}). Exporte a área do imóvel como polígono.`);
    }
    const partes = [];
    let off = 100;
    while (off + 8 <= dv.byteLength) {
      const tamanho = dv.getInt32(off + 4, false) * 2;
      const ini = off + 8;
      off = ini + tamanho;
      if (tamanho < 4 || off > dv.byteLength) break;
      const tipo = dv.getInt32(ini, true);
      if (tipo === 0) continue; // feição nula
      if (!TIPOS_POLIGONO.has(tipo)) continue;
      const nPartes = dv.getInt32(ini + 36, true), nPontos = dv.getInt32(ini + 40, true);
      if (nPartes < 1 || nPontos < 3 || 44 + 4 * nPartes + 16 * nPontos > tamanho) throw new Error("feição corrompida no shapefile");
      const indices = [];
      for (let i = 0; i < nPartes; i++) indices.push(dv.getInt32(ini + 44 + 4 * i, true));
      const base = ini + 44 + 4 * nPartes;
      const aneis = [];
      for (let k = 0; k < nPartes; k++) {
        const de = indices[k], ate = k + 1 < nPartes ? indices[k + 1] : nPontos;
        const anel = [];
        for (let i = de; i < ate; i++) anel.push([dv.getFloat64(base + 16 * i, true), dv.getFloat64(base + 16 * i + 8, true)]);
        if (anel.length >= 3) aneis.push(anel);
      }
      if (aneis.length) partes.push({ aneis });
    }
    if (!partes.length) throw new Error("o shapefile não tem nenhum polígono");
    return partes;
  }

  // ---------- .prj ----------
  function lerPrj(texto) {
    if (!texto) return { tipo: "desconhecido" };
    const t = String(texto);
    if (/^\s*(GEOGCS|GEOGCRS|GEODCRS)\b/i.test(t)) return { tipo: "graus", datum: nomeDatum(t) };
    if (!/PROJCS|PROJCRS/i.test(t)) return { tipo: "desconhecido" };
    if (!/Transverse_Mercator|Gauss_Kruger|UTM/i.test(t)) return { tipo: "naoSuportado", metodo: (t.match(/PROJECTION\["([^"]+)"/i) || [])[1] || "desconhecida" };
    const par = (nome, padrao) => {
      const m = t.match(new RegExp(`PARAMETER\\["${nome}",\\s*(-?[\\d.eE+-]+)`, "i"));
      return m ? Number(m[1]) : padrao;
    };
    const esf = t.match(/SPHEROID\["[^"]*",\s*([\d.]+),\s*([\d.]+)/i);
    const a = esf ? Number(esf[1]) : 6378137;
    const invf = esf ? Number(esf[2]) : 298.257222101;
    let lon0 = par("Central_Meridian", NaN);
    const zona = (t.match(/UTM[_ ]zone[_ ]?(\d{1,2})\s*([NS])?/i) || [])[1];
    if (!Number.isFinite(lon0) && zona) lon0 = Number(zona) * 6 - 183;
    if (!Number.isFinite(lon0)) throw new Error("não foi possível ler o meridiano central no arquivo .prj");
    const unidade = (t.match(/UNIT\["([^"]+)",\s*([\d.]+)/gi) || []).pop();
    const fator = unidade ? Number(unidade.match(/,\s*([\d.]+)/)[1]) : 1;
    if (Math.abs(fator - 1) > 1e-9) throw new Error("o .prj usa unidade que não é metro; reexporte o shapefile em SIRGAS 2000 (graus) ou UTM em metros");
    return {
      tipo: "tm", datum: nomeDatum(t),
      lon0, lat0: par("Latitude_Of_Origin", 0), k0: par("Scale_Factor", 0.9996),
      fe: par("False_Easting", 500000), fn: par("False_Northing", 0), a, f: 1 / invf,
    };
  }
  function nomeDatum(t) {
    const m = t.match(/(?:DATUM|GEODETICDATUM)\["([^"]+)"/i);
    return m ? m[1] : "";
  }
  const datumCompativel = (d) => !d || /SIRGAS|Sistema[_ ]de[_ ]Referencia[_ ]Geocentrico|America[_ ]del[_ ]Sur[_ ]2000|WGS[_ ]?(19)?84|GRS[_ ]?1980|ITRF|NAD_?83/i.test(d);

  // Transversa de Mercator inversa (Snyder, série): metros -> graus.
  function tmInversa(p, x, y) {
    const e2 = 2 * p.f - p.f * p.f, ep2 = e2 / (1 - e2);
    const arco = (fi) => p.a * ((1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * fi
      - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * Math.sin(2 * fi)
      + (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * Math.sin(4 * fi)
      - (35 * e2 ** 3 / 3072) * Math.sin(6 * fi));
    const M = arco(p.lat0 * RAD) + (y - p.fn) / p.k0;
    const mu = M / (p.a * (1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256));
    const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
    const fi1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
      + (151 * e1 ** 3 / 96) * Math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
    const s = Math.sin(fi1), c = Math.cos(fi1), tg = Math.tan(fi1);
    const C1 = ep2 * c * c, T1 = tg * tg;
    const N1 = p.a / Math.sqrt(1 - e2 * s * s);
    const R1 = p.a * (1 - e2) / (1 - e2 * s * s) ** 1.5;
    const D = (x - p.fe) / (N1 * p.k0);
    const lat = fi1 - (N1 * tg / R1) * (D * D / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D ** 4 / 24
      + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D ** 6 / 720);
    const lon = p.lon0 * RAD + (D - (1 + 2 * T1 + C1) * D ** 3 / 6
      + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D ** 5 / 120) / c;
    return [lon / RAD, lat / RAD];
  }

  // ---------- .dbf (só para sugerir o nome) ----------
  function lerNomeDbf(buffer) {
    try {
      const u8 = new Uint8Array(buffer);
      const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
      const nReg = dv.getUint32(4, true), tamCab = dv.getUint16(8, true), tamReg = dv.getUint16(10, true);
      const campos = [];
      let desloc = 1;
      for (let o = 32; o < tamCab - 1 && u8[o] !== 0x0d; o += 32) {
        const nome = new TextDecoder("latin1").decode(u8.subarray(o, o + 11)).replace(/\0.*$/, "");
        const tam = u8[o + 16];
        campos.push({ nome, desloc, tam });
        desloc += tam;
      }
      const preferidos = [/^nom(e)?_?(imovel|prop|fazenda)?$/i, /nome|name|denom/i, /imovel|propriedade|fazenda/i];
      for (const re of preferidos) {
        const campo = campos.find((c) => re.test(c.nome));
        if (!campo) continue;
        for (let r = 0; r < Math.min(nReg, 50); r++) {
          const ini = tamCab + r * tamReg;
          if (ini + tamReg > u8.length || u8[ini] === 0x2a) continue;
          const bytes = u8.subarray(ini + campo.desloc, ini + campo.desloc + campo.tam);
          let txt;
          try { txt = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { txt = new TextDecoder("latin1").decode(bytes); }
          txt = txt.replace(/\0/g, "").trim();
          if (txt) return txt;
        }
      }
    } catch { /* o nome é só uma sugestão */ }
    return "";
  }

  // ---------- .zip ----------
  // Leitor mínimo (diretório central; métodos 0 e 8). Devolve { nomeNoZip: Uint8Array }.
  async function lerZip(buffer) {
    const u8 = new Uint8Array(buffer);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let fim = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { fim = i; break; }
    if (fim < 0) throw new Error("arquivo .zip inválido");
    const n = dv.getUint16(fim + 10, true);
    let o = dv.getUint32(fim + 16, true);
    const saida = {};
    for (let k = 0; k < n; k++) {
      if (dv.getUint32(o, true) !== 0x02014b50) break;
      const metodo = dv.getUint16(o + 10, true), tamComp = dv.getUint32(o + 20, true);
      const tamNome = dv.getUint16(o + 28, true), tamExtra = dv.getUint16(o + 30, true), tamCom = dv.getUint16(o + 32, true);
      const locais = dv.getUint32(o + 42, true);
      const nome = new TextDecoder().decode(u8.subarray(o + 46, o + 46 + tamNome));
      o += 46 + tamNome + tamExtra + tamCom;
      if (nome.endsWith("/") || !/\.(shp|dbf|prj)$/i.test(nome)) continue;
      const ini = locais + 30 + dv.getUint16(locais + 26, true) + dv.getUint16(locais + 28, true);
      const comp = u8.subarray(ini, ini + tamComp);
      if (metodo === 0) saida[nome] = comp;
      else if (metodo === 8) saida[nome] = await inflar(comp);
      else throw new Error("o .zip usa um método de compressão não suportado");
    }
    return saida;
  }
  async function inflar(bytes) {
    if (typeof DecompressionStream === "undefined") throw new Error("este navegador não abre .zip; envie o .shp (e .prj) soltos");
    const fluxo = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(fluxo).arrayBuffer());
  }

  // ---------- simplificação (Douglas-Peucker em km locais) ----------
  function simplificarAnel(anel, tolKm, kx) {
    const pts = anel.map(([lon, lat]) => [lon * kx, lat * 111.32]);
    const manter = new Uint8Array(pts.length);
    manter[0] = manter[pts.length - 1] = 1;
    const pilha = [[0, pts.length - 1]];
    while (pilha.length) {
      const [a, b] = pilha.pop();
      let maior = 0, idx = -1;
      const [ax, ay] = pts[a], [bx, by] = pts[b];
      const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
      for (let i = a + 1; i < b; i++) {
        const t = len2 ? Math.max(0, Math.min(1, ((pts[i][0] - ax) * dx + (pts[i][1] - ay) * dy) / len2)) : 0;
        const d = Math.hypot(pts[i][0] - (ax + t * dx), pts[i][1] - (ay + t * dy));
        if (d > maior) { maior = d; idx = i; }
      }
      if (maior > tolKm && idx > 0) { manter[idx] = 1; pilha.push([a, idx], [idx, b]); }
    }
    const r = anel.filter((_, i) => manter[i]);
    return r.length >= 4 ? r : anel; // nunca degenera um anel
  }
  function contarVertices(partes) {
    return partes.reduce((s, p) => s + p.aneis.reduce((t, a) => t + a.length, 0), 0);
  }
  // Reduz até caber em `maximo` vértices, aumentando a tolerância (começa em 2 m). Devolve a tolerância usada.
  function simplificar(partes, maximo = 3000) {
    if (contarVertices(partes) <= maximo) return { partes, toleranciaM: 0 };
    const latMedia = partes[0].aneis[0][0][1];
    const kx = 111.32 * Math.cos(latMedia * RAD);
    let tol = 0.002;
    for (let i = 0; i < 12; i++, tol *= 2) {
      const novas = partes.map((p) => ({ aneis: p.aneis.map((a) => simplificarAnel(a, tol, kx)) }));
      if (contarVertices(novas) <= maximo) return { partes: novas, toleranciaM: Math.round(tol * 1000) };
    }
    throw new Error("o polígono é complexo demais; simplifique-o no QGIS antes de importar");
  }

  // ---------- junta tudo ----------
  /**
   * @param {{name:string, buffer:ArrayBuffer|Uint8Array}[]} arquivos .shp, .prj, .dbf e/ou um .zip
   * @returns {Promise<{partes, nomeSugerido:string, avisos:string[], toleranciaM:number, verticesOriginais:number}>}
   */
  async function carregarShapefile(arquivos) {
    const porNome = {};
    for (const a of arquivos) {
      if (/\.zip$/i.test(a.name)) Object.assign(porNome, await lerZip(a.buffer));
      else porNome[a.name] = a.buffer;
    }
    const achar = (ext) => Object.keys(porNome).filter((n) => n.toLowerCase().endsWith(ext));
    const shps = achar(".shp");
    if (!shps.length) throw new Error("falta o arquivo .shp");
    if (shps.length > 1) throw new Error(`o conjunto tem ${shps.length} shapefiles (${shps.slice(0, 3).join(", ")}…); envie só o do imóvel`);
    const base = shps[0].replace(/\.shp$/i, "");
    const com = (ext) => porNome[Object.keys(porNome).find((n) => n.toLowerCase() === (base + ext).toLowerCase())];
    const avisos = [];
    let partes = lerShp(porNome[shps[0]]);
    const prjBytes = com(".prj");
    const prj = lerPrj(prjBytes ? new TextDecoder().decode(prjBytes instanceof ArrayBuffer ? new Uint8Array(prjBytes) : prjBytes) : "");

    if (prj.tipo === "naoSuportado") throw new Error(`projeção "${prj.metodo}" não suportada; reexporte em SIRGAS 2000 (graus) ou UTM`);
    if (prj.tipo === "tm") {
      partes = partes.map((p) => ({ aneis: p.aneis.map((a) => a.map(([x, y]) => tmInversa(prj, x, y))) }));
    } else if (prj.tipo === "desconhecido") {
      const fora = partes.some((p) => p.aneis.some((a) => a.some(([x, y]) => Math.abs(x) > 180 || Math.abs(y) > 90)));
      if (fora) throw new Error("as coordenadas não parecem estar em graus e não há arquivo .prj; envie o .prj junto (ou reexporte em SIRGAS 2000)");
      avisos.push("Sem arquivo .prj: coordenadas lidas como graus (SIRGAS 2000/WGS 84).");
    }
    if (!datumCompativel(prj.datum)) avisos.push(`Datum "${prj.datum}" difere de SIRGAS 2000/WGS 84: a posição pode deslocar dezenas de metros.`);
    for (const p of partes) for (const a of p.aneis) for (const [lon, lat] of a) {
      if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90) throw new Error("coordenadas inválidas no shapefile");
    }
    // fecha anéis abertos
    for (const p of partes) for (const a of p.aneis) {
      const [a0, an] = [a[0], a[a.length - 1]];
      if (a0[0] !== an[0] || a0[1] !== an[1]) a.push([a0[0], a0[1]]);
    }
    const verticesOriginais = contarVertices(partes);
    const simp = simplificar(partes);
    const dbf = com(".dbf");
    return {
      partes: simp.partes, toleranciaM: simp.toleranciaM, verticesOriginais, avisos,
      nomeSugerido: dbf ? lerNomeDbf(dbf instanceof ArrayBuffer ? dbf : dbf.buffer.slice(dbf.byteOffset, dbf.byteOffset + dbf.byteLength)) : "",
    };
  }

  const api = { carregarShapefile, lerShp, lerPrj, tmInversa, lerNomeDbf, lerZip, simplificar, contarVertices };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else raiz.Shapefile = api;
})(typeof window !== "undefined" ? window : globalThis);
