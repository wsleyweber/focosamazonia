// Geometria de áreas monitoradas: círculo (lat/lon/raio) ou imóvel (polígono de shapefile + folga).
// Único lugar com essa regra: o servidor (lib/geo.js) e a página (app.js) usam este mesmo arquivo.
// Sem dependência de DOM nem de Leaflet, para poder ser testado em Node (veja testes/area-geo.test.js).
//
// Área de imóvel:  { lat, lon, raio, folga, partes: [ { aneis: [ [[lon,lat], ...], ... ] }, ... ] }
//  - `partes` = uma por feição do shapefile; dentro de cada parte vale a regra par-ímpar (anéis internos = buracos);
//    o imóvel é a UNIÃO das partes.
//  - `folga` (km): faixa monitorada em volta do imóvel.
//  - `lat`/`lon` = centro do retângulo do imóvel (ponto do vento); `raio` = círculo que envolve imóvel + folga.
//    `raio` só serve de pré-filtro barato: a decisão usa a distância ao polígono.
(function (raiz) {
  const RAD = Math.PI / 180;
  const KM_POR_GRAU = 111.32;

  const ehImovel = (area) => !!(area && Array.isArray(area.partes) && area.partes.length);
  // Distância máxima (km) até a qual um foco conta como "da área".
  const alcanceKm = (area) => (ehImovel(area) ? Number(area.folga) || 0 : area.raio);

  function haversineKm(a, b, c, d) {
    const dLat = (c - a) * RAD, dLon = (d - b) * RAD;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a * RAD) * Math.cos(c * RAD) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.sqrt(h));
  }

  // Projeção plana local (km) em torno do centro da área: erro desprezível para imóveis e folgas de alguns km.
  function projetor(lat0, lon0) {
    const kx = KM_POR_GRAU * Math.cos(lat0 * RAD);
    return {
      kx,
      x: (lon) => (lon - lon0) * kx,
      y: (lat) => (lat - lat0) * KM_POR_GRAU,
      lon: (x) => lon0 + x / kx,
      lat: (y) => lat0 + y / KM_POR_GRAU,
    };
  }

  const cache = new WeakMap(); // objeto da área -> geometria preparada (invalida se partes/centro mudarem)
  function preparar(area) {
    const guardada = cache.get(area);
    if (guardada && guardada.partes === area.partes && guardada.lat === area.lat && guardada.lon === area.lon) return guardada;
    const p = projetor(area.lat, area.lon);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const partes = area.partes.map((parte) => {
      const aneis = parte.aneis.map((anel) => anel.map(([lon, lat]) => [p.x(lon), p.y(lat)]));
      for (const anel of aneis) for (const [x, y] of anel) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
      return aneis;
    });
    const g = { partes: area.partes, lat: area.lat, lon: area.lon, p, aneis: partes, minX, minY, maxX, maxY };
    cache.set(area, g);
    return g;
  }

  function dentroDoAnel(x, y, anel) {
    let dentro = false;
    for (let i = 0, j = anel.length - 1; i < anel.length; j = i++) {
      const [xi, yi] = anel[i], [xj, yj] = anel[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) dentro = !dentro;
    }
    return dentro;
  }

  // Menor distância (km) de um ponto ao contorno de um anel, com o ponto mais próximo.
  function distanciaAoAnel(x, y, anel, melhor) {
    for (let i = 0, j = anel.length - 1; i < anel.length; j = i++) {
      const [ax, ay] = anel[j], [bx, by] = anel[i];
      const dx = bx - ax, dy = by - ay;
      const t = dx || dy ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy))) : 0;
      const px = ax + t * dx, py = ay + t * dy;
      const d2 = (x - px) ** 2 + (y - py) ** 2;
      if (d2 < melhor.d2) { melhor.d2 = d2; melhor.x = px; melhor.y = py; }
    }
  }

  /**
   * Distância de um ponto à área. Círculo: distância ao centro. Imóvel: 0 dentro do polígono; fora, distância ao
   * contorno mais próximo. `ref` é o ponto da área de onde se mede a direção até o foco (centro, ou o ponto
   * mais próximo do contorno).
   */
  function medirPonto(area, lat, lon) {
    if (!ehImovel(area)) return { km: haversineKm(area.lat, area.lon, lat, lon), ref: { lat: area.lat, lon: area.lon }, dentro: false };
    // pré-filtro: longe demais do retângulo do imóvel (folga + margem) nem calcula
    const g = preparar(area);
    const x = g.p.x(lon), y = g.p.y(lat);
    const lim = alcanceKm(area) + 1;
    if (x < g.minX - lim || x > g.maxX + lim || y < g.minY - lim || y > g.maxY + lim) {
      return { km: Infinity, ref: { lat: area.lat, lon: area.lon }, dentro: false };
    }
    for (const aneis of g.aneis) {
      let impar = false;
      for (const anel of aneis) if (dentroDoAnel(x, y, anel)) impar = !impar;
      if (impar) return { km: 0, ref: { lat: area.lat, lon: area.lon }, dentro: true };
    }
    const melhor = { d2: Infinity, x: 0, y: 0 };
    for (const aneis of g.aneis) for (const anel of aneis) distanciaAoAnel(x, y, anel, melhor);
    return { km: Math.sqrt(melhor.d2), ref: { lat: g.p.lat(melhor.y), lon: g.p.lon(melhor.x) }, dentro: false };
  }

  // Cálculos de cadastro: retângulo, centro, círculo envolvente e área (hectares).
  function resumirPartes(partes) {
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity, vertices = 0;
    for (const parte of partes) for (const anel of parte.aneis) for (const [lon, lat] of anel) {
      if (lon < w) w = lon; if (lon > e) e = lon;
      if (lat < s) s = lat; if (lat > n) n = lat;
      vertices++;
    }
    const lat = (s + n) / 2, lon = (w + e) / 2;
    const p = projetor(lat, lon);
    let maxD = 0;
    for (const parte of partes) for (const anel of parte.aneis) for (const [lo, la] of anel) {
      maxD = Math.max(maxD, Math.hypot(p.x(lo), p.y(la)));
    }
    return { lat, lon, bbox: { w, s, e, n }, vertices, raioImovelKm: maxD, hectares: hectaresDasPartes(partes, p) };
  }

  // Área em hectares da maior parte (par-ímpar: anéis dentro de um número ímpar de outros são buracos). Não soma
  // as partes porque feições de um mesmo imóvel costumam se sobrepor; é só informação ao usuário, não entra na decisão.
  function hectaresDasPartes(partes, p) {
    let melhorKm2 = 0;
    for (const parte of partes) {
      let km2 = 0;
      const areas = parte.aneis.map((anel) => {
        let a = 0;
        for (let i = 0, j = anel.length - 1; i < anel.length; j = i++) {
          a += p.x(anel[j][0]) * p.y(anel[i][1]) - p.x(anel[i][0]) * p.y(anel[j][1]);
        }
        return Math.abs(a / 2);
      });
      // anéis: os que estão dentro de um número ímpar de outros são buracos
      parte.aneis.forEach((anel, i) => {
        const [lo, la] = anel[0];
        let profundidade = 0;
        parte.aneis.forEach((outro, k) => {
          if (k !== i && areas[k] > areas[i] && dentroDoAnel(p.x(lo), p.y(la), outro.map(([a, b]) => [p.x(a), p.y(b)]))) profundidade++;
        });
        km2 += profundidade % 2 ? -areas[i] : areas[i];
      });
      melhorKm2 = Math.max(melhorKm2, km2);
    }
    return Math.max(0, melhorKm2) * 100;
  }

  function descreverAlcance(area) {
    return ehImovel(area) ? `no imóvel e a até ${fmt(area.folga)} km dele` : `em ${fmt(area.raio)} km`;
  }
  function descreverDistancia(area, km) {
    if (ehImovel(area)) return km < 0.05 ? "dentro do imóvel" : `${km.toFixed(1)} km do imóvel`;
    return `${km.toFixed(1)} km`;
  }
  const fmt = (n) => String(Math.round(Number(n) * 100) / 100).replace(".", ",");

  const api = { ehImovel, alcanceKm, medirPonto, resumirPartes, haversineKm, projetor, descreverAlcance, descreverDistancia };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else raiz.AreaGeo = api;
})(typeof window !== "undefined" ? window : globalThis);
