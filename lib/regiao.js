// Região monitorada: polígono(s) carregado(s) de um GeoJSON (gerado por scripts/gerar-regiao.js).
// contem(lat, lon) responde se um ponto está dentro dela. Um teste ponto-em-polígono direto custaria
// milhares de arestas por foco; por isso uma grade de células responde sozinha nas células inteiramente
// dentro ou fora, e só as células cortadas pela borda caem no teste exato.
const fs = require("fs");

const RESOLUCAO_GRAUS = 0.05; // ~5,5 km; 0,05° mantém a grade com cerca de 300 mil células para a Amazônia Legal
const FORA = 0, DENTRO = 1, BORDA = 2;

function paraAnel(coords) {
  const n = coords.length;
  const xs = new Float64Array(n), ys = new Float64Array(n);
  let w = Infinity, s = Infinity, e = -Infinity, nn = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = coords[i][0], y = coords[i][1];
    xs[i] = x; ys[i] = y;
    if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > nn) nn = y;
  }
  return { xs, ys, n, w, s, e, nn };
}

function pontoNoAnel(x, y, anel) {
  if (x < anel.w || x > anel.e || y < anel.s || y > anel.nn) return false;
  const { xs, ys, n } = anel;
  let dentro = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    if ((ys[i] > y) !== (ys[j] > y) && x < ((xs[j] - xs[i]) * (y - ys[i])) / (ys[j] - ys[i]) + xs[i]) dentro = !dentro;
  }
  return dentro;
}

function extrairPoligonos(geojson) {
  const geometrias = [];
  const visitar = (g) => {
    if (!g) return;
    if (g.type === "FeatureCollection") g.features.forEach(visitar);
    else if (g.type === "Feature") visitar(g.geometry);
    else if (g.type === "Polygon") geometrias.push([g.coordinates]);
    else if (g.type === "MultiPolygon") geometrias.push(g.coordinates);
  };
  visitar(geojson);
  const poligonos = [];
  for (const conjunto of geometrias) {
    for (const aneis of conjunto) {
      if (!aneis.length || aneis[0].length < 4) continue;
      const [externo, ...buracos] = aneis.map(paraAnel);
      poligonos.push({ externo, buracos });
    }
  }
  if (!poligonos.length) throw new Error("o GeoJSON da região não tem nenhum polígono");
  return poligonos;
}

function segmentoCruzaCelula(x1, y1, x2, y2, cx0, cy0, cx1, cy1) {
  // separação por reta: se os 4 cantos ficam do mesmo lado da reta do segmento, não cruza
  const dx = x2 - x1, dy = y2 - y1;
  let positivos = 0, negativos = 0;
  for (const [px, py] of [[cx0, cy0], [cx1, cy0], [cx1, cy1], [cx0, cy1]]) {
    const v = dx * (py - y1) - dy * (px - x1);
    if (v > 0) positivos++; else if (v < 0) negativos++; else { positivos++; negativos++; }
  }
  return positivos > 0 && negativos > 0;
}

class Regiao {
  constructor(geojson, { nome, resolucao = RESOLUCAO_GRAUS } = {}) {
    this.nome = nome || geojson.name || "Região monitorada";
    this.geojson = geojson;
    this.poligonos = extrairPoligonos(geojson);
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const p of this.poligonos) {
      if (p.externo.w < w) w = p.externo.w; if (p.externo.e > e) e = p.externo.e;
      if (p.externo.s < s) s = p.externo.s; if (p.externo.nn > n) n = p.externo.nn;
    }
    // retângulo que envolve a região, arredondado para fora em 0,01°: usado na consulta à FIRMS e na validação de áreas
    const fora = (v, f) => Math.round(f(v * 100)) / 100;
    this.bbox = { w: fora(w, Math.floor), s: fora(s, Math.floor), e: fora(e, Math.ceil), n: fora(n, Math.ceil) };
    this.resolucao = resolucao;
    this.nx = Math.max(1, Math.ceil((e - w) / resolucao));
    this.ny = Math.max(1, Math.ceil((n - s) / resolucao));
    this.grade = new Uint8Array(this.nx * this.ny); // FORA (0) por padrão
    this.#preencherGrade();
  }

  // Teste exato (sem grade). Público para validar a grade nos testes.
  contemExato(lat, lon) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
    for (const p of this.poligonos) {
      if (!pontoNoAnel(lon, lat, p.externo)) continue;
      if (p.buracos.some((b) => pontoNoAnel(lon, lat, b))) continue;
      return true;
    }
    return false;
  }

  contem(lat, lon) {
    const { w, s, e, n } = this.bbox;
    if (!(lon >= w && lon <= e && lat >= s && lat <= n)) return false; // também rejeita NaN
    const cx = Math.min(this.nx - 1, Math.floor((lon - w) / this.resolucao));
    const cy = Math.min(this.ny - 1, Math.floor((lat - s) / this.resolucao));
    const estado = this.grade[cy * this.nx + cx];
    return estado === BORDA ? this.contemExato(lat, lon) : estado === DENTRO;
  }

  #preencherGrade() {
    const { w, s } = this.bbox;
    const { nx, ny, resolucao: r, grade } = this;
    // 1) marca as células que alguma aresta atravessa
    for (const p of this.poligonos) {
      for (const anel of [p.externo, ...p.buracos]) {
        const { xs, ys, n } = anel;
        for (let i = 0; i < n; i++) {
          // laço circular: cobre também a aresta de fechamento caso o anel venha sem repetir o 1º ponto
          const x1 = xs[i], y1 = ys[i], x2 = xs[(i + 1) % n], y2 = ys[(i + 1) % n];
          const c0 = Math.max(0, Math.floor((Math.min(x1, x2) - w) / r)), c1 = Math.min(nx - 1, Math.floor((Math.max(x1, x2) - w) / r));
          const l0 = Math.max(0, Math.floor((Math.min(y1, y2) - s) / r)), l1 = Math.min(ny - 1, Math.floor((Math.max(y1, y2) - s) / r));
          for (let ly = l0; ly <= l1; ly++) {
            for (let cx = c0; cx <= c1; cx++) {
              const idx = ly * nx + cx;
              if (grade[idx] === BORDA) continue;
              if (segmentoCruzaCelula(x1, y1, x2, y2, w + cx * r, s + ly * r, w + (cx + 1) * r, s + (ly + 1) * r)) grade[idx] = BORDA;
            }
          }
        }
      }
    }
    // 2) em cada linha, uma sequência contínua de células sem borda tem o mesmo estado: um teste exato por sequência
    for (let ly = 0; ly < ny; ly++) {
      let cx = 0;
      while (cx < nx) {
        if (grade[ly * nx + cx] === BORDA) { cx++; continue; }
        let fim = cx;
        while (fim + 1 < nx && grade[ly * nx + fim + 1] !== BORDA) fim++;
        const estado = this.contemExato(s + (ly + 0.5) * r, w + (cx + 0.5) * r) ? DENTRO : FORA;
        if (estado === DENTRO) grade.fill(DENTRO, ly * nx + cx, ly * nx + fim + 1);
        cx = fim + 1;
      }
    }
  }
}

function carregarRegiao(origem, opcoes) {
  const geojson = typeof origem === "string" ? JSON.parse(fs.readFileSync(origem, "utf8")) : origem;
  return new Regiao(geojson, opcoes);
}

module.exports = { Regiao, carregarRegiao, pontoNoAnel, extrairPoligonos, RESOLUCAO_GRAUS };
