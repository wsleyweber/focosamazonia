#!/usr/bin/env node
// Gera assets/regiao.geojson (a região monitorada) a partir de shapefiles do IBGE.
// Node puro, sem dependências: lê .shp e .dbf, filtra por atributo, simplifica (Douglas-Peucker)
// e grava um GeoJSON pequeno o bastante para o servidor carregar na inicialização.
//
// Exemplo (o que gerou o arquivo atual):
//   node scripts/gerar-regiao.js \
//     --camada "Biomas_250mil/lm_bioma_250.shp:Bioma=Amazônia" \
//     --retangulo=-61.7,-18.1,-50.2,-7.3 \
//     --nome "Amazônia (bioma IBGE) + Mato Grosso" \
//     --saida assets/regiao.geojson
//
// Quando tiver o limite oficial da Amazônia Legal (IBGE), troque tudo por uma camada só:
//   node scripts/gerar-regiao.js --camada "Limites_Amazonia_Legal_2024.shp" \
//     --nome "Amazônia Legal" --saida assets/regiao.geojson
//
// Opções:
//   --camada ARQ.shp[:CAMPO=VALOR]  pode repetir; sem filtro usa todos os registros (acentos e caixa são ignorados)
//   --retangulo w,s,e,n             adiciona um retângulo (graus) como parte extra da região
//   --tolerancia GRAUS              simplificação; 0,005° ≈ 550 m (padrão). A máscara errará só junto das bordas
//   --area-min-km2 N                descarta ilhas/pedaços menores que N km² (padrão 5)
//   --nome TEXTO                    nome exibido pelo servidor
//   --saida ARQ                     padrão: assets/regiao.geojson
const fs = require("fs");
const path = require("path");

// ---------- leitura de shapefile ----------
const TIPOS_POLIGONO = new Set([5, 15, 25]); // Polygon, PolygonZ, PolygonM: x,y vêm no mesmo lugar

function lerDbf(caminho) {
  const buf = fs.readFileSync(caminho);
  const n = buf.readUInt32LE(4), tamCab = buf.readUInt16LE(8), tamReg = buf.readUInt16LE(10);
  const cpg = caminho.replace(/\.dbf$/i, ".cpg");
  const cpgTexto = fs.existsSync(cpg) ? fs.readFileSync(cpg, "utf8").trim().toLowerCase() : "";
  const codificacao = /1252|latin|iso-8859/.test(cpgTexto) ? "latin1" : "utf8";
  const campos = [];
  for (let o = 32; o < tamCab && buf[o] !== 0x0d; o += 32) {
    campos.push({ nome: buf.toString("latin1", o, o + 11).replace(/\0.*$/, ""), tam: buf[o + 16] });
  }
  const registros = [];
  for (let i = 0; i < n; i++) {
    let o = tamCab + i * tamReg + 1; // 1º byte = marca de exclusão
    const r = {};
    for (const c of campos) { r[c.nome] = buf.toString(codificacao, o, o + c.tam).trim(); o += c.tam; }
    registros.push(r);
  }
  return registros;
}

function lerShp(caminho) {
  const buf = fs.readFileSync(caminho);
  if (buf.readInt32BE(0) !== 9994) throw new Error(`${caminho} não é um shapefile (código de arquivo inválido)`);
  const formas = [];
  let off = 100;
  while (off + 8 <= buf.length) {
    const tamBytes = buf.readInt32BE(off + 4) * 2;
    const c = off + 8;
    const tipo = buf.readInt32LE(c);
    if (TIPOS_POLIGONO.has(tipo)) {
      const nPartes = buf.readInt32LE(c + 36), nPontos = buf.readInt32LE(c + 40);
      const inicios = [];
      for (let k = 0; k < nPartes; k++) inicios.push(buf.readInt32LE(c + 44 + 4 * k));
      inicios.push(nPontos);
      const base = c + 44 + 4 * nPartes;
      const aneis = [];
      for (let k = 0; k < nPartes; k++) {
        const anel = [];
        for (let p = inicios[k]; p < inicios[k + 1]; p++) {
          anel.push([buf.readDoubleLE(base + 16 * p), buf.readDoubleLE(base + 16 * p + 8)]);
        }
        aneis.push(anel);
      }
      formas.push(aneis);
    } else if (tipo === 0) {
      formas.push([]); // registro nulo: mantém o alinhamento com o .dbf
    } else {
      throw new Error(`tipo de forma ${tipo} não suportado (esperado polígono)`);
    }
    off = c + tamBytes;
  }
  return formas;
}

// ---------- geometria ----------
const areaAssinada = (anel) => {
  let s = 0;
  for (let i = 0, j = anel.length - 1; i < anel.length; j = i++) s += (anel[j][0] * anel[i][1]) - (anel[i][0] * anel[j][1]);
  return s / 2; // > 0 = anti-horário (eixo y para cima)
};

const bboxDe = (anel) => {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of anel) { if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y; }
  return [w, s, e, n];
};

function pontoNoAnel(x, y, anel) {
  let dentro = false;
  for (let i = 0, j = anel.length - 1; i < anel.length; j = i++) {
    const [xi, yi] = anel[i], [xj, yj] = anel[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) dentro = !dentro;
  }
  return dentro;
}

function distPontoSegmento(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const comp = dx * dx + dy * dy;
  let t = comp ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / comp : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

// Douglas-Peucker iterativo (os anéis têm centenas de milhares de pontos: recursão estouraria a pilha).
function simplificarLinha(pontos, tolerancia) {
  const n = pontos.length;
  if (n < 3) return pontos.slice();
  const manter = new Uint8Array(n);
  manter[0] = manter[n - 1] = 1;
  const pilha = [[0, n - 1]];
  while (pilha.length) {
    const [ini, fim] = pilha.pop();
    let maior = -1, idx = -1;
    for (let i = ini + 1; i < fim; i++) {
      const d = distPontoSegmento(pontos[i], pontos[ini], pontos[fim]);
      if (d > maior) { maior = d; idx = i; }
    }
    if (maior > tolerancia) { manter[idx] = 1; pilha.push([ini, idx], [idx, fim]); }
  }
  return pontos.filter((_, i) => manter[i]);
}

// Anel fechado: divide no ponto mais distante do primeiro para não degenerar (início = fim).
function simplificarAnel(anel, tolerancia) {
  const aberto = anel.length > 1 && anel[0][0] === anel[anel.length - 1][0] && anel[0][1] === anel[anel.length - 1][1]
    ? anel.slice(0, -1) : anel.slice();
  if (aberto.length < 4) return [];
  let longe = 0, dMax = -1;
  for (let i = 1; i < aberto.length; i++) {
    const d = Math.hypot(aberto[i][0] - aberto[0][0], aberto[i][1] - aberto[0][1]);
    if (d > dMax) { dMax = d; longe = i; }
  }
  const a = simplificarLinha(aberto.slice(0, longe + 1), tolerancia);
  const b = simplificarLinha(aberto.slice(longe).concat([aberto[0]]), tolerancia);
  const resultado = a.concat(b.slice(1, -1));
  if (resultado.length < 3) return [];
  resultado.push(resultado[0]);
  return resultado;
}

const arredondar = (anel, casas = 4) => anel.map(([x, y]) => [+x.toFixed(casas), +y.toFixed(casas)]);
const KM2_POR_GRAU2 = 111.32 * 111.32; // aproximação válida perto do equador, suficiente para descartar ilhotas

// Monta polígonos (anel externo + buracos) a partir dos anéis soltos do shapefile.
// Convenção do shapefile: externos horários, buracos anti-horários.
function montarPoligonos(aneis, { tolerancia, areaMinKm2 }) {
  const externos = [], buracos = [];
  for (const anel of aneis) {
    if (anel.length < 4) continue;
    (areaAssinada(anel) <= 0 ? externos : buracos).push({ anel, bb: bboxDe(anel) });
  }
  const poligonos = externos.map((e) => ({ externo: e, buracos: [] }));
  for (const b of buracos) {
    const [px, py] = b.anel[0];
    // o menor externo que contém o buraco
    let dono = null, areaDono = Infinity;
    for (const p of poligonos) {
      const [w, s, e, n] = p.externo.bb;
      if (px < w || px > e || py < s || py > n) continue;
      const area = Math.abs(areaAssinada(p.externo.anel));
      if (area < areaDono && pontoNoAnel(px, py, p.externo.anel)) { dono = p; areaDono = area; }
    }
    if (dono) dono.buracos.push(b.anel);
  }
  const saida = [];
  for (const p of poligonos) {
    const externo = simplificarAnel(p.externo.anel, tolerancia);
    if (!externo.length) continue;
    if (Math.abs(areaAssinada(externo)) * KM2_POR_GRAU2 < areaMinKm2) continue; // ilhota
    const furos = p.buracos
      .map((h) => simplificarAnel(h, tolerancia))
      .filter((h) => h.length && Math.abs(areaAssinada(h)) * KM2_POR_GRAU2 >= areaMinKm2);
    // RFC 7946: externo anti-horário, buracos horários
    const ext = areaAssinada(externo) < 0 ? externo.slice().reverse() : externo;
    const fur = furos.map((h) => (areaAssinada(h) > 0 ? h.slice().reverse() : h));
    saida.push([arredondar(ext), ...fur.map((h) => arredondar(h))]);
  }
  return saida;
}

const normalizar = (t) => String(t).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

function carregarCamada(especificacao, opcoes) {
  const m = especificacao.match(/^(.*?\.shp)(?::([^=]+)=(.*))?$/i);
  if (!m) throw new Error(`--camada inválida: ${especificacao} (use arquivo.shp ou arquivo.shp:CAMPO=VALOR)`);
  const [, arquivo, campo, valor] = m;
  const formas = lerShp(arquivo);
  let selecionadas = formas.map((aneis, i) => ({ aneis, i }));
  let atributos = null;
  if (campo) {
    atributos = lerDbf(arquivo.replace(/\.shp$/i, ".dbf"));
    if (!atributos.length || !(campo in atributos[0])) {
      throw new Error(`campo ${campo} não existe no .dbf (campos: ${Object.keys(atributos[0] || {}).join(", ")})`);
    }
    selecionadas = selecionadas.filter(({ i }) => normalizar(atributos[i][campo]) === normalizar(valor));
    if (!selecionadas.length) {
      throw new Error(`nenhum registro com ${campo}=${valor} (valores: ${[...new Set(atributos.map((a) => a[campo]))].join(", ")})`);
    }
  }
  const aneis = selecionadas.flatMap((s) => s.aneis);
  const vertices = aneis.reduce((t, a) => t + a.length, 0);
  const poligonos = montarPoligonos(aneis, opcoes);
  return {
    origem: path.basename(arquivo) + (campo ? ` (${campo}=${valor})` : ""),
    verticesOriginais: vertices,
    poligonos,
  };
}

function retanguloComoPoligono([w, s, e, n]) {
  return [[[w, s], [e, s], [e, n], [w, n], [w, s]]];
}

function gerarRegiao({ camadas = [], retangulos = [], nome = "Região monitorada", tolerancia = 0.005, areaMinKm2 = 5 }) {
  const opcoes = { tolerancia, areaMinKm2 };
  const features = [];
  const resumo = [];
  for (const spec of camadas) {
    const c = carregarCamada(spec, opcoes);
    features.push({ type: "Feature", properties: { origem: c.origem }, geometry: { type: "MultiPolygon", coordinates: c.poligonos } });
    resumo.push(`${c.origem}: ${c.verticesOriginais} -> ${c.poligonos.reduce((t, p) => t + p.reduce((u, a) => u + a.length, 0), 0)} vértices, ${c.poligonos.length} polígono(s)`);
  }
  for (const r of retangulos) {
    features.push({
      type: "Feature",
      properties: { origem: `retângulo ${r.join(",")}`, provisorio: true },
      geometry: { type: "MultiPolygon", coordinates: [retanguloComoPoligono(r)] },
    });
    resumo.push(`retângulo ${r.join(",")}`);
  }
  if (!features.length) throw new Error("informe ao menos uma --camada ou --retangulo");
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const f of features) for (const poligono of f.geometry.coordinates) for (const [x, y] of poligono[0]) {
    if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y;
  }
  const pad = (v) => +v.toFixed(2);
  const bbox = [pad(Math.floor(w * 100) / 100), pad(Math.floor(s * 100) / 100), pad(Math.ceil(e * 100) / 100), pad(Math.ceil(n * 100) / 100)];
  return {
    geojson: { type: "FeatureCollection", name: nome, bbox, tolerancia, features },
    resumo,
  };
}

// ---------- linha de comando ----------
function lerArgumentos(argv) {
  const a = { camadas: [], retangulos: [] };
  for (let i = 0; i < argv.length; i++) {
    let [chave, valor] = argv[i].split(/=(.*)/s);
    if (valor === undefined && !["--help"].includes(chave)) valor = argv[++i];
    switch (chave) {
      case "--camada": a.camadas.push(valor); break;
      case "--retangulo": {
        const nums = valor.split(",").map(Number);
        if (nums.length !== 4 || nums.some((x) => !Number.isFinite(x))) throw new Error("--retangulo espera w,s,e,n");
        a.retangulos.push(nums); break;
      }
      case "--tolerancia": a.tolerancia = Number(valor); break;
      case "--area-min-km2": a.areaMinKm2 = Number(valor); break;
      case "--nome": a.nome = valor; break;
      case "--saida": a.saida = valor; break;
      case "--help": a.ajuda = true; break;
      default: throw new Error(`opção desconhecida: ${chave}`);
    }
  }
  return a;
}

function principal() {
  const args = lerArgumentos(process.argv.slice(2));
  if (args.ajuda || (!args.camadas.length && !args.retangulos.length)) {
    console.log(fs.readFileSync(__filename, "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
    return;
  }
  const { geojson, resumo } = gerarRegiao(args);
  const saida = path.resolve(args.saida || path.join(__dirname, "..", "assets", "regiao.geojson"));
  fs.mkdirSync(path.dirname(saida), { recursive: true });
  fs.writeFileSync(saida, JSON.stringify(geojson));
  console.log(resumo.join("\n"));
  console.log(`bbox: ${geojson.bbox.join(", ")}`);
  console.log(`gravado ${saida} (${(fs.statSync(saida).size / 1024).toFixed(0)} KB)`);
}

if (require.main === module) {
  try { principal(); } catch (e) { console.error("erro:", e.message); process.exit(1); }
}

module.exports = {
  lerShp, lerDbf, simplificarLinha, simplificarAnel, montarPoligonos, gerarRegiao, areaAssinada, pontoNoAnel, lerArgumentos,
};
