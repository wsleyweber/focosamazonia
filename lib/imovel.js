// Validação de áreas de imóvel (polígono vindo de shapefile + folga) no cadastro.
// A leitura do shapefile acontece no navegador (public/shapefile.js); aqui o servidor só confere o que recebeu.
const AreaGeo = require("../public/area-geo");

const FOLGA_PADRAO_KM = 5;
const FOLGA_MAX_KM = 50;
const MAX_PARTES = 200;
const MAX_ANEIS = 2000;
const MAX_VERTICES = 20000;
const MAX_EXTENSAO_KM = 600; // um imóvel maior que isso é erro de arquivo, não propriedade

function validarFolga(valor) {
  const folga = valor == null || valor === "" ? FOLGA_PADRAO_KM : Number(valor);
  if (!Number.isFinite(folga) || folga < 0 || folga > FOLGA_MAX_KM) return { erro: `a folga deve estar entre 0 e ${FOLGA_MAX_KM} km` };
  return { folga };
}

// Devolve { partes, lat, lon, raio, hectares, bbox, vertices } ou { erro }.
function prepararImovel(partesBrutas, folga, bboxRegiao) {
  if (!Array.isArray(partesBrutas) || !partesBrutas.length || partesBrutas.length > MAX_PARTES) return { erro: "polígono do imóvel inválido" };
  const partes = [];
  let vertices = 0, aneisTotal = 0;
  for (const parte of partesBrutas) {
    if (!parte || !Array.isArray(parte.aneis) || !parte.aneis.length) return { erro: "polígono do imóvel inválido" };
    const aneis = [];
    for (const anel of parte.aneis) {
      if (!Array.isArray(anel) || anel.length < 4) return { erro: "polígono do imóvel com anel incompleto" };
      const pts = [];
      for (const p of anel) {
        const lon = Array.isArray(p) ? Number(p[0]) : NaN, lat = Array.isArray(p) ? Number(p[1]) : NaN;
        if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90) return { erro: "polígono do imóvel com coordenada inválida" };
        pts.push([Math.round(lon * 1e7) / 1e7, Math.round(lat * 1e7) / 1e7]); // ~1 cm
      }
      vertices += pts.length;
      aneisTotal++;
      aneis.push(pts);
    }
    partes.push({ aneis });
  }
  if (vertices > MAX_VERTICES || aneisTotal > MAX_ANEIS) return { erro: "polígono complexo demais; simplifique-o antes de importar" };
  const r = AreaGeo.resumirPartes(partes);
  const extensaoKm = Math.max(
    AreaGeo.haversineKm(r.bbox.s, r.bbox.w, r.bbox.s, r.bbox.e),
    AreaGeo.haversineKm(r.bbox.s, r.bbox.w, r.bbox.n, r.bbox.w)
  );
  if (extensaoKm > MAX_EXTENSAO_KM) return { erro: "o polígono é grande demais para ser um imóvel; confira o arquivo" };
  const { w, s, e, n } = bboxRegiao;
  if (r.lat < s || r.lat > n || r.lon < w || r.lon > e) return { erro: "o imóvel está fora da área monitorada" };
  return {
    partes, lat: r.lat, lon: r.lon, bbox: r.bbox, vertices, hectares: r.hectares,
    // círculo que envolve imóvel + folga: só pré-filtro; a decisão usa a distância ao polígono
    raio: Math.ceil((r.raioImovelKm + folga) * 100) / 100,
  };
}

module.exports = { prepararImovel, validarFolga, FOLGA_PADRAO_KM, FOLGA_MAX_KM };
