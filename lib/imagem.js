// Gera um PNG de uma área monitorada: mapa de fundo (OpenStreetMap), focos, raio e vento.
// Usa @napi-rs/canvas (binário pronto, sem compilar nada) em vez de abrir um navegador.
const { createCanvas, loadImage, GlobalFonts } = require("@napi-rs/canvas");
const path = require("path");
const { nomePonto, idadeMinutos, formatarIdade, descreverAlcance, descreverDistancia } = require("./geo");
const AreaGeo = require("../public/area-geo");

const TAM_TILE = 256;
const LARGURA = 640;
const ALTURA = 440;
const ALTURA_TITULO = 46;
const ALTURA_RODAPE = 56;
const ALTURA_MAPA = ALTURA - ALTURA_TITULO - ALTURA_RODAPE;
const MARGEM_CIRCULO_PX = 5;
const COR = { ok: "#2f7d4f", atencao: "#c77700", alto: "#c92a2a" };
const TITULO = { ok: "SEM FOCOS PRÓXIMOS", atencao: "ATENÇÃO: FOCO NA ÁREA", alto: "ALERTA: FOCO PRÓXIMO OU A FAVOR DO VENTO" };

// Símbolos dos focos: mesmos valores do mapa (public/index.html). Manter sincronizados.
const COR_POTENCIA = { baixa: "#f0a500", media: "#e8590c", alta: "#b30000", geo: "#9aa0a6" };
const ESTILO_FOCO = {
  raio: 4,
  meiaDiagonalConfirmado: 6,
  peso: 1,
  corGeo: "#202020",
  pesoGeo: 2,
  tracejadoGeo: [4, 3],
};

const CAMINHO_FONTE = path.join(__dirname, "..", "assets", "fonts", "Roboto.ttf");
if (!GlobalFonts.registerFromPath(CAMINHO_FONTE, "Roboto")) {
  throw new Error(`não foi possível registrar a fonte da imagem: ${CAMINHO_FONTE}`);
}
const F_TITULO = "Roboto";
const F_TEXTO = F_TITULO;

function projetar(lat, lon, zoom) {
  const n = 2 ** zoom;
  const x = ((lon + 180) / 360) * n * TAM_TILE;
  const rad = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n * TAM_TILE;
  return { x, y };
}

function metrosPorPixel(lat, zoom) {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
}

function escolherZoom(lat, raioMetros) {
  const raioMaximoPx = Math.min(LARGURA, ALTURA_MAPA) / 2 - MARGEM_CIRCULO_PX;
  for (let z = 15; z >= 3; z--) {
    // Usa o maior zoom que mantém todo o círculo, com sua borda, dentro da área útil.
    if (raioMetros / metrosPorPixel(lat, z) <= raioMaximoPx) return z;
  }
  return 3;
}

function opacidadeFoco(foco, agora = Date.now()) {
  const idade = idadeMinutos(foco, agora);
  if (idade == null) return 0.4;
  if (idade <= 3 * 60) return 0.9;
  if (idade <= 12 * 60) return 0.65;
  if (idade <= 24 * 60) return 0.4;
  return 0.25;
}

const focoConfirmado = (f) => f.confirmacoes >= 2 && !f.somenteGeo;
const corFoco = (f) => (f.somenteGeo ? COR_POTENCIA.geo
  : f.frp > 50 ? COR_POTENCIA.alta : f.frp > 10 ? COR_POTENCIA.media : COR_POTENCIA.baixa);

// Círculo = 1 satélite; losango = 2 ou mais satélites; cinza tracejado = só geoestacionário.
function desenharFoco(ctx, x, y, f, alpha) {
  const cor = corFoco(f);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  if (focoConfirmado(f)) {
    const d = ESTILO_FOCO.meiaDiagonalConfirmado;
    ctx.moveTo(x, y - d); ctx.lineTo(x + d, y); ctx.lineTo(x, y + d); ctx.lineTo(x - d, y);
    ctx.closePath();
  } else {
    ctx.arc(x, y, ESTILO_FOCO.raio, 0, Math.PI * 2);
  }
  ctx.fillStyle = cor;
  ctx.fill();
  ctx.lineWidth = f.somenteGeo ? ESTILO_FOCO.pesoGeo : ESTILO_FOCO.peso;
  ctx.strokeStyle = f.somenteGeo ? ESTILO_FOCO.corGeo : cor;
  if (f.somenteGeo) ctx.setLineDash(ESTILO_FOCO.tracejadoGeo);
  ctx.stroke();
  ctx.restore();
}

// Corta o texto com reticências para caber na largura, em vez de espremer a fonte.
function ajustarTexto(ctx, texto, larguraMax) {
  if (ctx.measureText(texto).width <= larguraMax) return texto;
  let t = texto;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > larguraMax) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

const cacheTiles = new Map(); // "z/x/y" -> Buffer; tiles raramente mudam, cache em memória do processo
async function buscarTile(z, x, y) {
  const n = 2 ** z;
  const xm = ((x % n) + n) % n; // mundo dá a volta no eixo x
  if (y < 0 || y >= n) return null;
  const chave = `${z}/${xm}/${y}`;
  if (cacheTiles.has(chave)) return cacheTiles.get(chave);
  const ua = process.env.OSM_USER_AGENT || "monitor-focos-mt/1.0 (uso pessoal)";
  const r = await fetch(`https://tile.openstreetmap.org/${z}/${xm}/${y}.png`, {
    headers: { "User-Agent": ua },
    signal: AbortSignal.timeout(5000), // lentidão do OSM não trava a geração da imagem
  });
  if (!r.ok) return null;
  const buf = Buffer.from(await r.arrayBuffer());
  if (cacheTiles.size > 500) cacheTiles.clear(); // evita crescer sem limite numa sessão longa
  cacheTiles.set(chave, buf);
  return buf;
}

async function desenharMapaDeFundo(ctx, centroPx, zoom) {
  const centroTelaY = ALTURA_TITULO + ALTURA_MAPA / 2;
  const origemX = centroPx.x - LARGURA / 2;
  const origemY = centroPx.y - centroTelaY;
  const txIni = Math.floor(origemX / TAM_TILE), txFim = Math.floor((origemX + LARGURA) / TAM_TILE);
  const tyIni = Math.floor(origemY / TAM_TILE), tyFim = Math.floor((origemY + ALTURA) / TAM_TILE);
  const buscas = [];
  for (let ty = tyIni; ty <= tyFim; ty++)
    for (let tx = txIni; tx <= txFim; tx++)
      buscas.push(
        buscarTile(zoom, tx, ty).then((buf) => ({ tx, ty, buf })).catch(() => ({ tx, ty, buf: null }))
      );
  const tiles = await Promise.all(buscas);
  for (const { tx, ty, buf } of tiles) {
    const dx = tx * TAM_TILE - origemX, dy = ty * TAM_TILE - origemY;
    if (!buf) { ctx.fillStyle = "#e5e2d8"; ctx.fillRect(dx, dy, TAM_TILE, TAM_TILE); continue; }
    try { ctx.drawImage(await loadImage(buf), dx, dy, TAM_TILE, TAM_TILE); }
    catch { ctx.fillStyle = "#e5e2d8"; ctx.fillRect(dx, dy, TAM_TILE, TAM_TILE); }
  }
  return { origemX, origemY };
}

/**
 * Desenha o PNG de uma área.
 * @param {{nome,lat,lon,raio}} area
 * @param {Array} focos focos já mesclados (lat, lon, frp, confirmacoes, somenteGeo)
 * @param {object|null} vento {velocidadeKmh, direcaoDeGraus, rajadaKmh, umidade}
 * @param {{nivel,total,maisProximo,contraVento,confirmados}} analise saída de analisarArea()
 * @returns {Promise<Buffer>} PNG
 */
async function gerarImagemArea(area, focos, vento, analise) {
  const canvas = createCanvas(LARGURA, ALTURA);
  const ctx = canvas.getContext("2d");
  const zoom = escolherZoom(area.lat, area.raio * 1000);
  const centroPx = projetar(area.lat, area.lon, zoom);
  const mpp = metrosPorPixel(area.lat, zoom);
  const { origemX, origemY } = await desenharMapaDeFundo(ctx, centroPx, zoom);
  const paraTela = (lat, lon) => {
    const p = projetar(lat, lon, zoom);
    return { x: p.x - origemX, y: p.y - origemY };
  };

  const cor = COR[analise.nivel] || COR.ok;
  const c = paraTela(area.lat, area.lon);
  const raioPx = (area.raio * 1000) / mpp;

  if (AreaGeo.ehImovel(area)) {
    // Imóvel: faixa de folga = traço grosso (largura 2 x folga) com juntas redondas, desenhado de uma vez só (sem
    // somar transparência); por cima, o polígono do imóvel.
    const caminho = () => {
      ctx.beginPath();
      for (const parte of area.partes) for (const anel of parte.aneis) {
        anel.forEach(([lon, lat], i) => { const p = paraTela(lat, lon); i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); });
        ctx.closePath();
      }
    };
    ctx.save();
    caminho();
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    ctx.lineWidth = 2 * ((area.folga * 1000) / mpp);
    ctx.globalAlpha = 0.18; ctx.strokeStyle = cor; ctx.stroke();
    ctx.restore();
    ctx.save();
    caminho();
    ctx.globalAlpha = 0.3; ctx.fillStyle = cor; ctx.fill("evenodd");
    ctx.globalAlpha = 1; ctx.lineWidth = 2.5; ctx.strokeStyle = cor; ctx.stroke();
    ctx.restore();
  } else {
    // Círculo da área
    ctx.beginPath();
    ctx.arc(c.x, c.y, raioPx, 0, Math.PI * 2);
    ctx.fillStyle = cor + "22";
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = cor;
    ctx.stroke();
  }

  // Focos (confirmados por último, ficam por cima, como no mapa)
  const ordenados = focos.slice().sort((a, b) => Number(focoConfirmado(a)) - Number(focoConfirmado(b)));
  for (const f of ordenados) {
    const p = paraTela(f.lat, f.lon);
    if (p.x < -20 || p.y < -20 || p.x > LARGURA + 20 || p.y > ALTURA + 20) continue;
    desenharFoco(ctx, p.x, p.y, f, opacidadeFoco(f));
  }

  // Seta de vento (para onde ele vai = direção "de onde vem" + 180°), abaixo do título
  if (vento && Number.isFinite(vento.direcaoDeGraus)) {
    const cx = LARGURA - 56, cy = ALTURA_TITULO + 40, r = 24;
    const paraGraus = (vento.direcaoDeGraus + 180) % 360;
    const rad = (paraGraus * Math.PI) / 180;
    ctx.save();
    ctx.fillStyle = "#ffffffcc";
    ctx.beginPath(); ctx.arc(cx, cy, r + 8, 0, Math.PI * 2); ctx.fill();
    ctx.translate(cx, cy); ctx.rotate(rad);
    ctx.beginPath();
    ctx.moveTo(0, -r); ctx.lineTo(8, r * 0.55); ctx.lineTo(0, r * 0.3); ctx.lineTo(-8, r * 0.55);
    ctx.closePath();
    ctx.fillStyle = "#1f6fb2";
    ctx.fill();
    ctx.restore();
    ctx.fillStyle = "#1d211c";
    ctx.font = `bold 12px ${F_TEXTO}`;
    ctx.textAlign = "center";
    ctx.fillText(`${Math.round(vento.velocidadeKmh)} km/h`, cx, cy + r + 20);
  }

  // Faixa de título
  ctx.fillStyle = cor;
  ctx.fillRect(0, 0, LARGURA, ALTURA_TITULO);
  ctx.fillStyle = "#fff";
  ctx.textAlign = "left";
  ctx.font = `bold 17px ${F_TITULO}`;
  ctx.fillText(ajustarTexto(ctx, area.nome, LARGURA - 28), 14, 20);
  ctx.font = `bold 12px ${F_TEXTO}`;
  ctx.fillText(TITULO[analise.nivel] || "", 14, 37);

  // Faixa de informações no rodapé (fundo escuro quase opaco para o texto branco ter contraste)
  ctx.fillStyle = "#141710cc";
  ctx.fillRect(0, ALTURA - ALTURA_RODAPE, LARGURA, ALTURA_RODAPE);
  ctx.fillStyle = "#fff";
  ctx.font = `13px ${F_TEXTO}`;
  const linha1 = analise.total
    ? `${analise.total} foco(s) ${AreaGeo.ehImovel(area) ? "na área monitorada" : "no raio"} · mais próximo: ${descreverDistancia(area, analise.maisProximo.km)}, a ${nomePonto(analise.maisProximo.rumo)} · observado ${formatarIdade(idadeMinutos(analise.maisProximo.f))}${analise.maisProximo.f.somenteGeo ? " · não confirmado (só geo); potência n/d" : ""}`
    : `Nenhum foco detectado ${descreverAlcance(area)}`;
  ctx.fillText(ajustarTexto(ctx, linha1, LARGURA - 28), 14, ALTURA - 36);
  const linha2 = vento
    ? `Vento ${Math.round(vento.velocidadeKmh)} km/h, rajadas ${Math.round(vento.rajadaKmh)} km/h · Bombeiros 193`
    : "Vento indisponível · Bombeiros 193";
  ctx.fillText(ajustarTexto(ctx, linha2, LARGURA - 200), 14, ALTURA - 18);

  // Atribuição do mapa discreta no rodapé, sem cobrir a área ou sua legenda.
  ctx.textAlign = "right";
  ctx.font = `10px ${F_TEXTO}`;
  ctx.fillStyle = "#ffffffcc";
  ctx.fillText("© OpenStreetMap contributors", LARGURA - 8, ALTURA - 4);

  return canvas.toBuffer("image/png");
}

module.exports = { gerarImagemArea, escolherZoom, opacidadeFoco };
