// Geometria usada pelo servidor e, em cópia, pela página.
const AreaGeo = require("../public/area-geo"); // mesma geometria da página (círculo ou imóvel + folga)
const RAD = Math.PI / 180;
const PONTOS = ["N", "NE", "L", "SE", "S", "SO", "O", "NO"];
const NOMES_PONTOS = ["Norte", "Nordeste", "Leste", "Sudeste", "Sul", "Sudoeste", "Oeste", "Noroeste"];
const CONFIG_PADRAO = {
  distAlertaKm: 5,
  ventoMaxKm: 30,
  ventoMinKmh: 0,
  idadeMaxVentoH: 6,
  geoPodeAlertar: false,
};

function distanciaKm(a, b, c, d) {
  const dLat = (c - a) * RAD, dLon = (d - b) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a * RAD) * Math.cos(c * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

function rumo(a, b, c, d) {
  const y = Math.sin((d - b) * RAD) * Math.cos(c * RAD);
  const x = Math.cos(a * RAD) * Math.sin(c * RAD) - Math.sin(a * RAD) * Math.cos(c * RAD) * Math.cos((d - b) * RAD);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

const difAngulo = (x, y) => Math.abs(((x - y + 540) % 360) - 180);
const ponto = (graus) => PONTOS[Math.round(graus / 45) % 8];
const nomePonto = (graus) => {
  const indice = Math.round(graus / 45) % 8;
  return `${NOMES_PONTOS[indice]} (${PONTOS[indice]})`;
};

function idadeMinutos(foco, agora = Date.now()) {
  if (!foco || !/^\d{4}-\d{2}-\d{2}$/.test(foco.data || "") || !/^\d{4}$/.test(foco.hora || "")) return null;
  const instante = Date.parse(`${foco.data}T${foco.hora.slice(0, 2)}:${foco.hora.slice(2)}:00Z`);
  if (!Number.isFinite(instante)) return null;
  return Math.max(0, Math.floor((agora - instante) / 60000));
}

function formatarIdade(minutos) {
  if (!Number.isFinite(minutos) || minutos < 0) return "idade desconhecida";
  if (minutos > 24 * 60) return "há mais de 24 h";
  if (minutos >= 60) {
    const horas = Math.floor(minutos / 60);
    const resto = minutos % 60;
    return resto ? `há ${horas} h ${resto} min` : `há ${horas} h`;
  }
  return `há ${Math.floor(minutos)} min`;
}

function analisarArea(area, focos, vento, cfg = CONFIG_PADRAO) {
  const config = { ...CONFIG_PADRAO, ...cfg };
  // km = distância ao centro (círculo) ou ao contorno do imóvel (0 = dentro dele); só entra quem está no alcance
  const alcance = AreaGeo.alcanceKm(area);
  const dentro = [];
  for (const f of focos) {
    const m = AreaGeo.medirPonto(area, f.lat, f.lon);
    if (m.km <= alcance) dentro.push({ f, km: m.km, ref: m.ref, dentroImovel: m.dentro });
  }
  dentro.sort((x, y) => x.km - y.km);
  let contraVento = 0;
  let contraVentoPerto = 0;
  for (const x of dentro) {
    x.rumo = rumo(x.ref.lat, x.ref.lon, x.f.lat, x.f.lon); // do ponto da área mais próximo do foco
    const idade = idadeMinutos(x.f);
    x.aFavor = !!vento
      && Number.isFinite(vento.direcaoDeGraus)
      && Number.isFinite(vento.velocidadeKmh)
      && vento.velocidadeKmh >= config.ventoMinKmh
      && idade != null
      && idade <= config.idadeMaxVentoH * 60
      && difAngulo(x.rumo, vento.direcaoDeGraus) <= 45;
    if (x.aFavor) {
      contraVento++;
      if ((!x.f.somenteGeo || config.geoPodeAlertar) && x.km <= config.ventoMaxKm) contraVentoPerto++;
    }
  }
  const maisProximo = dentro[0] || null;
  const motivos = [];
  const proximidade = dentro.some((x) =>
    x.km <= config.distAlertaKm && (!x.f.somenteGeo || config.geoPodeAlertar)
  );
  if (proximidade) motivos.push("proximidade");
  if (contraVentoPerto) motivos.push("vento");
  let nivel = "ok";
  if (dentro.length) nivel = "atencao";
  if (proximidade || contraVentoPerto) nivel = "alto";
  const confirmados = dentro.filter((x) => x.f.confirmacoes >= 2).length;
  return { nivel, total: dentro.length, dentro, maisProximo, contraVento, confirmados, motivos, contraVentoPerto };
}

module.exports = {
  distanciaKm, rumo, difAngulo, ponto, nomePonto, analisarArea, descreverAlcance: AreaGeo.descreverAlcance, descreverDistancia: AreaGeo.descreverDistancia, idadeMinutos, formatarIdade,
  CONFIG_PADRAO, PONTOS,
};
