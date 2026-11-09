(() => {
  // Retângulo que envolve a região: só enquadra o mapa e valida o cadastro de áreas (não é desenhado). Este é o valor
  // inicial; o servidor informa o real em /api/config (carregarConfig). O contorno desenhado vem de /api/regiao.
  let LIMITES = [[-18.11, -73.99], [5.27, -43.39]];
  const RAD = Math.PI / 180;
  const SIGLAS_PONTOS = ["N", "NE", "L", "SE", "S", "SO", "O", "NO"];
  const NOMES_PONTOS = ["Norte", "Nordeste", "Leste", "Sudeste", "Sul", "Sudoeste", "Oeste", "Noroeste"];
  const $ = (id) => document.getElementById(id);
  const COR = { ok: "#2f7d4f", atencao: "#a45e00", alto: "#b42323" };
  const COR_POTENCIA = { baixa: "#f0a500", media: "#e8590c", alta: "#b30000", geo: "#9aa0a6" };
  const COR_VENTO = "#1f6fb2";
  const ESTILO_FOCO = { raio: 4, raioConfirmado: 6, peso: 1, pesoConfirmado: 1, meiaDiagonalConfirmado: 6, corGeo: "#202020", pesoGeo: 2, tracejadoGeo: "4 3" };
  const OPACIDADE_IDADE = { recente: .9, media: .65, antiga: .4, muitoAntiga: .25 };

  // ---------- geometria (espelhada em lib/geo.js; manter as regras sincronizadas) ----------
  function distanciaKm(a, b, c, d) {
    const dLat = (c - a) * RAD, dLon = (d - b) * RAD;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a * RAD) * Math.cos(c * RAD) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.sqrt(h));
  }
  function limitesArea(area) {
    let w = area.lon, e = area.lon, s = area.lat, n = area.lat, alcance = area.raio;
    if (AreaGeo.ehImovel(area)) { // imóvel: retângulo do polígono + folga
      ({ w, s, e, n } = AreaGeo.resumirPartes(area.partes).bbox);
      alcance = area.folga;
    }
    const latDelta = alcance / 111.32;
    const lonDelta = alcance / (111.32 * Math.cos(area.lat * RAD));
    return L.latLngBounds([s - latDelta, w - lonDelta], [n + latDelta, e + lonDelta]);
  }
  function rumo(a, b, c, d) {
    const y = Math.sin((d - b) * RAD) * Math.cos(c * RAD);
    const x = Math.cos(a * RAD) * Math.sin(c * RAD) - Math.sin(a * RAD) * Math.cos(c * RAD) * Math.cos((d - b) * RAD);
    return (Math.atan2(y, x) / RAD + 360) % 360;
  }
  const difAngulo = (x, y) => Math.abs(((x - y + 540) % 360) - 180);
  const ponto = (g) => {
    const indice = Math.round(g / 45) % 8;
    return `${NOMES_PONTOS[indice]} (${SIGLAS_PONTOS[indice]})`;
  };

  // ---------- estado ----------
  let areas = [];
  let areasCarregadas = false;
  let focos = [];
  let todosFocos = [];
  const ventos = {};
  const analises = {};
  let areaSelecionada = null;
  let focoAnteriorPainel = null;
  let modoEscolha = false;
  let saude = null;
  let fontes = [];
  let ultimaAtualizacao = "";
  let marcaTemp = null;
  let preVisualizacao = null;
  let focoDestacado = null;
  let timerDestaque = null;
  let remocaoPendente = null;
  const marcadoresFocos = new Map(); // foco -> marcador no mapa (só os que estão desenhados agora)
  let omitidosServidor = 0; // focos que o servidor não enviou por causa do teto
  let resultadoZoom = { ocultosPorZoom: 0, ocultosPorTeto: 0 };

  function formatarIdade(minutos) {
    if (!Number.isFinite(minutos) || minutos < 0) return "idade desconhecida";
    if (minutos > 24 * 60) return "há mais de 24 h";
    if (minutos >= 60) {
      const horas = Math.floor(minutos / 60), resto = minutos % 60;
      return resto ? `há ${horas} h ${resto} min` : `há ${horas} h`;
    }
    return `há ${Math.floor(minutos)} min`;
  }
  function idadeMinutos(f) {
    if (!f || !/^\d{4}-\d{2}-\d{2}$/.test(f.data || "") || !/^\d{4}$/.test(f.hora || "")) return null;
    const instante = Date.parse(`${f.data}T${f.hora.slice(0, 2)}:${f.hora.slice(2)}:00Z`);
    return Number.isFinite(instante) ? Math.max(0, Math.floor((Date.now() - instante) / 60000)) : null;
  }
  function opacidadeFoco(f) {
    const idade = idadeMinutos(f);
    if (idade == null) return OPACIDADE_IDADE.antiga;
    if (idade <= 3 * 60) return OPACIDADE_IDADE.recente;
    if (idade <= 12 * 60) return OPACIDADE_IDADE.media;
    if (idade <= 24 * 60) return OPACIDADE_IDADE.antiga;
    return OPACIDADE_IDADE.muitoAntiga;
  }
  const NIVEL_CONF = { baixa: 0, nominal: 1, alta: 2 };
  const CONFIG_PADRAO = { distAlertaKm: 5, ventoMaxKm: 30, ventoMinKmh: 0, idadeMaxVentoH: 6, geoPodeAlertar: false, confiancaMinima: "nominal", inpeGeo: "off", geoMinDeteccoes: 2 };
  let config = { ...CONFIG_PADRAO };
  const ROTULO = { ok: "Sem focos", atencao: "Atenção", alto: "Alerta" };

  async function json(url) {
    const r = await fetch(url);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.erro || `Erro ${r.status}`);
    return j;
  }
  async function jsonPost(url, corpo) {
    const r = await fetch(url, corpo !== undefined
      ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo) }
      : { method: "POST" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.erro || `Erro ${r.status}`);
    return j;
  }
  function criar(tag, classe, texto) {
    const no = document.createElement(tag);
    if (classe) no.className = classe;
    if (texto !== undefined) no.textContent = texto;
    return no;
  }
  function botao(texto, acao, classe = "") {
    const b = criar("button", classe, texto);
    b.type = "button";
    b.addEventListener("click", acao);
    return b;
  }

  async function carregarConfig() {
    try { config = { ...CONFIG_PADRAO, ...await json("/api/config") }; }
    catch { config = { ...CONFIG_PADRAO }; }
    $("confianca").value = String(NIVEL_CONF[config.confiancaMinima] ?? 1);
    const opcaoGeo = $("fonte").querySelector('option[value="INPE_GEO"]');
    opcaoGeo.disabled = config.inpeGeo !== "on";
    opcaoGeo.textContent = config.inpeGeo === "off" ? "INPE GOES/MSG (modo off)"
      : config.inpeGeo === "observar" ? "INPE GOES/MSG (em observação)" : "INPE GOES/MSG (ativo)";
    $("estadoGeo").hidden = config.inpeGeo !== "observar";
    $("estadoGeo").textContent = config.inpeGeo === "observar"
      ? "INPE em observação: dados geoestacionários não entram no mapa nem nos alertas." : "";
    $("legendaGeo").hidden = config.inpeGeo !== "on";
    if (config.regiao && config.regiao.bbox) aplicarLimites(config.regiao.bbox);
  }
  // Cada polígono vira uma camada própria: partes sobrepostas não se anulam no preenchimento (regra par-ímpar do canvas).
  function poligonosDoGeoJson(g) {
    if (!g) return [];
    if (g.type === "FeatureCollection") return g.features.flatMap(poligonosDoGeoJson);
    if (g.type === "Feature") return poligonosDoGeoJson(g.geometry);
    if (g.type === "Polygon") return [g.coordinates];
    if (g.type === "MultiPolygon") return g.coordinates;
    return [];
  }
  async function carregarContornoRegiao() {
    try {
      const r = await fetch("/api/regiao");
      if (!r.ok) return;
      camadaRegiao.clearLayers();
      for (const aneis of poligonosDoGeoJson(await r.json())) {
        L.polygon(aneis.map((anel) => anel.map(([lon, lat]) => [lat, lon])), ESTILO_REGIAO).addTo(camadaRegiao);
      }
      camadaRegiao.bringToBack();
    } catch { /* sem contorno o mapa segue funcionando */ }
  }
  function aplicarLimites(b) {
    const novos = [[b.s, b.w], [b.n, b.e]];
    const mudou = JSON.stringify(novos) !== JSON.stringify(LIMITES);
    LIMITES = novos;
    if (mudou) mapa.fitBounds(LIMITES);
  }
  async function migrarAreasAntigas() {
    let antigas = [];
    try { antigas = JSON.parse(localStorage.getItem("areasMT") || "[]"); } catch {}
    if (!antigas.length) return;
    for (const a of antigas) {
      try {
        await fetch("/api/areas", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ nome: a.nome, lat: a.lat, lon: a.lon, raio: a.raio }),
        });
      } catch {}
    }
    try { localStorage.removeItem("areasMT"); } catch {}
  }
  async function carregarAreas() {
    areas = await json("/api/areas");
    areasCarregadas = true;
  }

  // ---------- mapa ----------
  const mapa = L.map("mapa", { zoomControl: false, attributionControl: false, preferCanvas: true }).fitBounds(LIMITES);
  mapa.createPane("marcadoresArea");
  mapa.getPane("marcadoresArea").style.zIndex = "430";
  mapa.createPane("caminhosCompartilhados");
  mapa.getPane("caminhosCompartilhados").style.zIndex = "450";
  const renderer = L.canvas({ pane: "caminhosCompartilhados", padding: .5, tolerance: 8 });
  const MarcadorConfirmado = L.CircleMarker.extend({
    _updatePath() {
      const { x, y } = this._point;
      const d = ESTILO_FOCO.meiaDiagonalConfirmado;
      const ctx = this._renderer._ctx;
      ctx.beginPath();
      ctx.moveTo(x, y - d);
      ctx.lineTo(x + d, y);
      ctx.lineTo(x, y + d);
      ctx.lineTo(x - d, y);
      ctx.closePath();
      this._renderer._fillStroke(ctx, this);
    },
  });
  // Imóvel + folga: o polígono vira uma camada por feição. A faixa de folga é um traço grosso (largura = 2 x folga em
  // pixels, recalculada a cada zoom) com juntas redondas, desenhado de uma vez só: é o "buffer" exato, sem somar
  // transparência. O polígono por cima segue o desenho normal do Leaflet (par-ímpar). Cliques valem na faixa toda.
  const CamadaImovel = L.Polygon.extend({
    _pxFolga() {
      if (!this._map) return 0;
      const mpp = (156543.03392 * Math.cos(this.options.latRef * RAD)) / 2 ** this._map.getZoom();
      return (this.options.folgaKm * 1000) / mpp;
    },
    _clickTolerance() { return this._pxFolga() + 2; },
    _updatePath() {
      const r = this._renderer, ctx = r._ctx;
      if (this._rings.length) {
        ctx.save();
        ctx.beginPath();
        for (const anel of this._rings) {
          anel.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
          ctx.closePath();
        }
        ctx.lineJoin = "round"; ctx.lineCap = "round";
        ctx.lineWidth = 2 * this._pxFolga();
        ctx.globalAlpha = this.options.opacidadeFolga;
        ctx.strokeStyle = this.options.color;
        ctx.stroke();
        ctx.restore();
      }
      r._updatePoly(this, true);
    },
  });
  function camadasImovel(area, opcoes, destino) {
    for (const parte of area.partes) {
      const aneis = parte.aneis.map((anel) => anel.map(([lon, lat]) => [lat, lon]));
      const c = new CamadaImovel(aneis, { renderer, latRef: area.lat, folgaKm: area.folga, fillRule: "evenodd", ...opcoes });
      c.addTo(destino);
    }
  }
  const ICONE_ZOOM = (d) => `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="square" stroke-linejoin="miter"/></svg>`;
  L.control.zoom({
    position: "bottomright",
    zoomInText: ICONE_ZOOM("M12 5v14M5 12h14"),
    zoomOutText: ICONE_ZOOM("M5 12h14"),
  }).addTo(mapa);
  L.control.attribution({ position: "bottomright" }).addTo(mapa);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(mapa);
  // Contorno da região monitorada (ex.: Amazônia Legal). Fica por baixo de áreas e focos e não captura cliques.
  const camadaRegiao = L.featureGroup().addTo(mapa);
  const ESTILO_REGIAO = { renderer, color: "#2e7d52", weight: 2, opacity: 0.85, fillColor: "#2e7d52", fillOpacity: 0.06, interactive: false, smoothFactor: 1.5 };
  const camadaAreas = L.featureGroup().addTo(mapa);
  const camadaFocos = L.featureGroup().addTo(mapa);
  const camadaTemporaria = L.featureGroup().addTo(mapa);

  function horaLocal(f) {
    const [a, m, d] = f.data.split("-").map(Number);
    const dt = new Date(Date.UTC(a, m - 1, d, +f.hora.slice(0, 2), +f.hora.slice(2)));
    return dt.toLocaleString("pt-BR", { timeZone: "America/Cuiaba", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  }
  function corFoco(f) {
    if (f.somenteGeo) return COR_POTENCIA.geo;
    return f.frp > 50 ? COR_POTENCIA.alta : f.frp > 10 ? COR_POTENCIA.media : COR_POTENCIA.baixa;
  }
  function tooltipArea(a) {
    const el = criar("span", "", a.nome);
    return el;
  }
  function criarPopupFoco(f) {
    const popup = criar("div");
    const hora = criar("strong", "", `${horaLocal(f)} (horário de Cuiabá)`);
    popup.append(hora, document.createElement("br"));
    const idade = idadeMinutos(f);
    const idadeTexto = `Observado ${formatarIdade(idade)}${idade != null && idade > 12 * 60 ? " (antigo)" : ""}`;
    popup.append(document.createTextNode(idadeTexto), document.createElement("br"));
    if (f.somenteGeo) {
      const geo = criar("strong", "", "Não confirmado (só geoestacionário)");
      popup.append(geo, document.createElement("br"));
    }
    const potencia = criar("span", "potenciaFoco");
    const amostra = criar("i", "pontoCor");
    const cor = corFoco(f);
    amostra.style.backgroundColor = cor;
    amostra.style.color = cor;
    if (f.confirmacoes >= 2 && !f.somenteGeo) amostra.classList.add("losango");
    potencia.append(amostra, document.createTextNode(`Potência: ${f.somenteGeo ? "n/d" : `${f.frp} MW`}`));
    popup.append(potencia, document.createElement("br"));
    popup.append(document.createTextNode(`Confiança: ${f.confianca || "não informada"}`), document.createElement("br"));
    const sats = (f.satelites || (f.satelite ? [f.satelite] : [])).join(", ");
    const listaSatelites = f.satelites || (f.satelite ? [f.satelite] : []);
    const polares = listaSatelites.filter((s) => !/GOES|MSG/i.test(s));
    const geoestacionarios = listaSatelites.filter((s) => /GOES|MSG/i.test(s));
    popup.append(document.createTextNode(`Satélites polares (${f.confirmacoes || 0}): ${polares.join(", ") || "nenhum"}`));
    if (geoestacionarios.length) {
      popup.append(document.createElement("br"), document.createTextNode(`Satélites geoestacionários: ${geoestacionarios.join(", ")}`));
    }
    return popup;
  }
  // Um único popup compartilhado, montado só quando alguém clica num foco. Antes cada foco desenhado
  // criava (e guardava) o seu popup; com milhares de focos isso custava memória e tempo a cada redesenho.
  const popupFoco = L.popup({ offset: [0, -ESTILO_FOCO.raio] });
  function abrirPopupFoco(f) {
    popupFoco.setLatLng([f.lat, f.lon]).setContent(criarPopupFoco(f)).openOn(mapa);
  }
  function criarAmostraFoco(cor, { confirmado = false, geo = false, opacidade = OPACIDADE_IDADE.recente } = {}) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const losango = confirmado && !geo;
    const forma = document.createElementNS("http://www.w3.org/2000/svg", losango ? "path" : "circle");
    const raio = geo ? ESTILO_FOCO.raio : confirmado ? ESTILO_FOCO.raioConfirmado : ESTILO_FOCO.raio;
    const peso = geo ? ESTILO_FOCO.pesoGeo : confirmado ? ESTILO_FOCO.pesoConfirmado : ESTILO_FOCO.peso;
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("width", "16");
    svg.setAttribute("height", "16");
    if (losango) {
      const d = ESTILO_FOCO.meiaDiagonalConfirmado;
      forma.setAttribute("d", `M8 ${8 - d} L${8 + d} 8 L8 ${8 + d} L${8 - d} 8 Z`);
    } else {
      forma.setAttribute("cx", "8");
      forma.setAttribute("cy", "8");
      forma.setAttribute("r", String(raio));
    }
    forma.setAttribute("fill", cor);
    forma.setAttribute("fill-opacity", String(opacidade));
    forma.setAttribute("stroke", geo ? ESTILO_FOCO.corGeo : cor);
    forma.setAttribute("stroke-opacity", String(opacidade));
    forma.setAttribute("stroke-width", String(peso));
    if (geo) forma.setAttribute("stroke-dasharray", ESTILO_FOCO.tracejadoGeo);
    svg.append(forma);
    return svg;
  }
  function destacarFoco(f) {
    focoDestacado = f;
    if (timerDestaque) clearTimeout(timerDestaque);
    mapa.setView([f.lat, f.lon], Math.max(mapa.getZoom(), 10));
    sincronizarFocos(); // garante o foco desenhado mesmo se um filtro ou a regra de zoom o escondesse
    abrirPopupFoco(f);
    timerDestaque = setTimeout(() => { focoDestacado = null; sincronizarFocos(); }, 3000);
  }
  function analisar(a) {
    const v = ventos[a.id];
    // km = distância ao centro (círculo) ou ao limite do imóvel (0 = dentro); regra única em area-geo.js
    const alcance = AreaGeo.alcanceKm(a);
    const dentro = [];
    for (const f of focos) {
      const m = AreaGeo.medirPonto(a, f.lat, f.lon);
      if (m.km <= alcance) dentro.push({ f, km: m.km, ref: m.ref, dentroImovel: m.dentro });
    }
    dentro.sort((x, y) => x.km - y.km);
    const maisProximo = dentro[0] || null;
    let contraVento = 0, contraVentoPerto = 0;
    for (const x of dentro) {
      x.rumo = rumo(x.ref.lat, x.ref.lon, x.f.lat, x.f.lon);
      const idade = idadeMinutos(x.f);
      x.aFavor = !!v && Number.isFinite(v.direcaoDeGraus) && Number.isFinite(v.velocidadeKmh)
        && v.velocidadeKmh >= config.ventoMinKmh
        && idade != null && idade <= config.idadeMaxVentoH * 60
        && difAngulo(x.rumo, v.direcaoDeGraus) <= 45;
      if (x.aFavor) {
        contraVento++;
        if ((!x.f.somenteGeo || config.geoPodeAlertar) && x.km <= config.ventoMaxKm) contraVentoPerto++;
      }
    }
    const proximidade = dentro.some((x) =>
      x.km <= config.distAlertaKm && (!x.f.somenteGeo || config.geoPodeAlertar)
    );
    const motivos = [];
    if (proximidade) motivos.push("proximidade");
    if (contraVentoPerto) motivos.push("vento");
    let nivel = "ok";
    if (dentro.length) nivel = "atencao";
    if (proximidade || contraVentoPerto) nivel = "alto";
    const confirmados = dentro.filter((x) => x.f.confirmacoes >= 2).length;
    return { nivel, total: dentro.length, dentro, maisProximo, contraVento, contraVentoPerto, confirmados, motivos };
  }
  function texto(a, an) {
    const v = ventos[a.id];
    if (!an.total) return `Nenhum foco detectado ${AreaGeo.descreverAlcance(a)}.`;
    const p = an.maisProximo;
    const statusGeo = p.f.somenteGeo ? " Não confirmado (só geoestacionário); potência n/d." : "";
    const idade = idadeMinutos(p.f);
    const antigo = idade != null && idade > 12 * 60 ? " (antigo)" : "";
    const onde = p.dentroImovel ? "" : `, a ${ponto(p.rumo)}`;
    let s = `${an.total} foco(s) ${AreaGeo.descreverAlcance(a)}. Mais próximo: ${AreaGeo.descreverDistancia(a, p.km)}${onde}, observado ${formatarIdade(idade)}${antigo}.${statusGeo}`;
    if (an.confirmados > 0) s += ` ${an.confirmados} confirmado(s) por 2 ou mais satélites.`;
    return s;
  }

  function criarMarcadorFoco(f) {
    const cor = corFoco(f);
    const confirmado = f.confirmacoes >= 2 && !f.somenteGeo;
    const idadeAlpha = opacidadeFoco(f);
    const criar = confirmado ? (latlng, opcoes) => new MarcadorConfirmado(latlng, opcoes) : L.circleMarker;
    const marcador = criar([f.lat, f.lon], {
      renderer,
      radius: f.somenteGeo ? ESTILO_FOCO.raio : confirmado ? ESTILO_FOCO.raioConfirmado : ESTILO_FOCO.raio,
      color: f.somenteGeo ? ESTILO_FOCO.corGeo : cor,
      fillColor: cor,
      weight: f.somenteGeo ? ESTILO_FOCO.pesoGeo : confirmado ? ESTILO_FOCO.pesoConfirmado : ESTILO_FOCO.peso,
      dashArray: f.somenteGeo ? ESTILO_FOCO.tracejadoGeo : null,
      opacity: idadeAlpha, fillOpacity: idadeAlpha, bubblingMouseEvents: false,
    });
    marcador._fogo = f;
    return marcador;
  }
  // Clique em qualquer foco: um só ouvinte no grupo (em vez de um por marcador), popup montado agora.
  camadaFocos.on("click", (evento) => {
    const f = evento.layer && evento.layer._fogo;
    if (f) abrirPopupFoco(f);
  });
  // Mantém desenhados só os focos que a regra de zoom aceita e que estão na tela (com folga).
  // Atualização incremental: o que continua visível não é recriado, então um popup aberto não fecha ao arrastar o mapa.
  function sincronizarFocos() {
    const limites = mapa.getBounds().pad(0.25);
    const base = focoDestacado && !focos.includes(focoDestacado) ? focos.concat([focoDestacado]) : focos;
    const r = RegrasZoom.selecionarFocosVisiveis(base, {
      zoom: mapa.getZoom(),
      limites: { w: limites.getWest(), s: limites.getSouth(), e: limites.getEast(), n: limites.getNorth() },
      destacado: focoDestacado,
    });
    resultadoZoom = r;
    const queremos = new Set(r.visiveis);
    let removidos = 0;
    for (const f of marcadoresFocos.keys()) if (!queremos.has(f)) removidos++;
    if (removidos > marcadoresFocos.size / 2) { // quase tudo mudou (dados novos): mais barato limpar de uma vez
      camadaFocos.clearLayers();
      marcadoresFocos.clear();
    } else {
      for (const [f, marcador] of marcadoresFocos) {
        if (!queremos.has(f)) { camadaFocos.removeLayer(marcador); marcadoresFocos.delete(f); }
      }
    }
    const novos = r.visiveis.filter((f) => !marcadoresFocos.has(f));
    for (const f of novos) {
      const marcador = criarMarcadorFoco(f);
      marcadoresFocos.set(f, marcador);
      camadaFocos.addLayer(marcador);
    }
    if (novos.length) { // confirmados (losangos) ficam por cima dos demais, como antes
      for (const [f, marcador] of marcadoresFocos) if (f.confirmacoes >= 2 && !f.somenteGeo) marcador.bringToFront();
    }
    camadaFocos.bringToFront();
    atualizarAvisoZoom(r);
    resumo();
  }
  function atualizarAvisoZoom(r) {
    const partes = [];
    if (r.ocultosPorZoom > 0) {
      partes.push(`Mostrando ${r.regra.descricao} (${r.ocultosPorZoom.toLocaleString("pt-BR")} ocultos neste zoom). Aproxime para ver todos; os alertas das áreas já consideram todos.`);
    }
    if (r.ocultosPorTeto > 0) {
      partes.push(`Muitos focos nesta região: mostrando os ${r.visiveis.length.toLocaleString("pt-BR")} mais relevantes (${r.ocultosPorTeto.toLocaleString("pt-BR")} ocultos). Aproxime para ver os demais.`);
    }
    $("avisoZoom").hidden = partes.length === 0;
    $("avisoZoom").textContent = partes.join(" ");
  }
  function iconeArea(a, nivel) {
    const v = ventos[a.id];
    const temVento = v && Number.isFinite(v.direcaoDeGraus);
    const rotacao = temVento ? (v.direcaoDeGraus + 180) % 360 : 0;
    const html = `<span class="setaArea" style="--cor-area:${COR[nivel]}">${temVento ? `<svg viewBox="0 0 24 24" aria-hidden="true" style="transform:rotate(${rotacao}deg)"><path d="M12 2 20 21 12 17 4 21Z" fill="${COR_VENTO}" stroke="white" stroke-width="1.5"/></svg>` : ""}</span>`;
    return L.divIcon({ className: "marcadorArea", html, iconSize: [40, 40], iconAnchor: [20, 20] });
  }
  function selecionarArea(a) {
    if (modoEscolha) return;
    if (!$("cartaoNova").hidden) {
      $("cartaoNova").hidden = true;
      $("botaoNova").setAttribute("aria-expanded", "false");
      atualizarEstadoSemAreas();
    }
    if (areaSelecionada !== a.id || $("painelArea").hidden) focoAnteriorPainel = obterFocoDeRetorno();
    areaSelecionada = a.id;
    desenharAreas();
    desenharPainelArea();
    const bounds = limitesArea(a);
    const foraDaTela = !mapa.getBounds().contains(bounds.getSouthWest()) || !mapa.getBounds().contains(bounds.getNorthEast());
    if (mapa.getZoom() < 8 || foraDaTela) {
      const mobile = matchMedia("(max-width: 800px)").matches;
      const alturaPainel = $("painelArea").getBoundingClientRect().height;
      const paddingInferior = mobile ? alturaPainel + 24 : 40;
      mapa.flyToBounds(bounds, {
        paddingTopLeft: [24, 90],
        paddingBottomRight: [mobile ? 24 : 420, paddingInferior],
        maxZoom: 12,
      });
    }
    $("painelArea").focus({ preventScroll: true });
  }
  function tooltipVento(v) {
    return criar("span", "", `Vento de ${ponto(v.direcaoDeGraus)} (${Math.round(v.direcaoDeGraus)}°), ${Math.round(v.velocidadeKmh)} km/h`);
  }
  function desenharAreas() {
    camadaAreas.clearLayers();
    const ordenadas = areas.slice().sort((a, b) => b.raio - a.raio);
    for (const a of ordenadas) {
      const an = analises[a.id];
      const nivel = an ? an.nivel : "ok";
      const selecionada = a.id === areaSelecionada;
      if (AreaGeo.ehImovel(a)) {
        const grupo = L.featureGroup();
        camadasImovel(a, {
          color: COR[nivel], weight: selecionada ? 3.5 : 2, fillColor: COR[nivel],
          fillOpacity: selecionada ? .3 : .2, opacidadeFolga: selecionada ? .2 : .12, bubblingMouseEvents: false,
        }, grupo);
        grupo.bindTooltip(tooltipArea(a), { sticky: true });
        grupo.on("click", () => selecionarArea(a));
        grupo.addTo(camadaAreas);
      } else {
        const circulo = L.circle([a.lat, a.lon], {
          renderer, radius: a.raio * 1000, color: COR[nivel], weight: selecionada ? 3.5 : 2,
          fillColor: COR[nivel], fillOpacity: selecionada ? .14 : .06,
          bubblingMouseEvents: false,
        }).bindTooltip(tooltipArea(a), { sticky: true });
        circulo.on("click", () => selecionarArea(a));
        circulo.addTo(camadaAreas);
      }
      const marcador = L.marker([a.lat, a.lon], {
        pane: "marcadoresArea", icon: iconeArea(a, nivel), keyboard: true,
        bubblingMouseEvents: false, title: a.nome, alt: `Abrir área ${a.nome}`,
      });
      marcador.on("click", () => selecionarArea(a));
      marcador.addTo(camadaAreas);
      const vento = ventos[a.id];
      if (vento && Number.isFinite(vento.direcaoDeGraus)) marcador.bindTooltip(tooltipVento(vento), { direction: "top" });
    }
    camadaAreas.bringToBack();
    camadaFocos.bringToFront();
  }

  // ---------- painel de área e menus ----------
  function criarLinhaDado(titulo, valor) {
    const p = criar("p", "linhaDado");
    const strong = criar("strong", "", `${titulo}: `);
    p.append(strong, document.createTextNode(valor));
    return p;
  }
  function abrirPainel(area) {
    if (areaSelecionada !== area.id || $("painelArea").hidden) focoAnteriorPainel = obterFocoDeRetorno();
    if (!$("cartaoNova").hidden) {
      $("cartaoNova").hidden = true;
      $("botaoNova").setAttribute("aria-expanded", "false");
      atualizarEstadoSemAreas();
    }
    areaSelecionada = area.id;
    fecharMenus();
    desenharAreas();
    desenharPainelArea();
    $("painelArea").hidden = false;
    $("painelArea").focus({ preventScroll: true });
  }
  function obterFocoDeRetorno() {
    const ativo = document.activeElement;
    if (ativo === document.body) return $("botaoAreas");
    if (ativo.closest("#menuAreas")) return $("botaoAreas");
    if (ativo.closest("#menuFiltros")) return $("botaoFiltros");
    if (ativo.closest("#cartaoNova")) return $("botaoNova");
    return ativo;
  }
  function desenharPainelArea() {
    const painel = $("painelArea");
    const area = areas.find((a) => a.id === areaSelecionada);
    if (!area) { painel.hidden = true; return; }
    painel.replaceChildren();
    painel.setAttribute("aria-label", `Detalhes da área ${area.nome}`);
    painel.append(criar("span", "folhaHandle"));
    const header = criar("div", "cabecalhoCartao");
    const titulo = criar("h2", "", area.nome);
    const analise = analises[area.id] || { nivel: "ok", total: 0, dentro: [], motivos: [] };
    const selo = criar("span", `selo ${analise.nivel}`, ROTULO[analise.nivel]);
    header.append(titulo, selo);
    painel.append(header);
    painel.append(criar("p", "resumoArea", texto(area, analise)));
    const porques = criar("section", "secaoCartao");
    porques.append(criar("h3", "", "Por que está neste nível"));
    const razoes = [];
    if (analise.motivos.includes("proximidade")) razoes.push(`Foco a menos de ${config.distAlertaKm} km${AreaGeo.ehImovel(area) ? " do imóvel" : ""}`);
    if (analise.motivos.includes("vento")) razoes.push(`Foco a favor do vento a menos de ${config.ventoMaxKm} km`);
    porques.append(criar("p", "", razoes.join(" · ") || (analise.total ? "Há focos no raio, mas nenhuma condição de Alerta." : "Nenhum foco no raio.")));
    painel.append(porques);
    const vento = ventos[area.id];
    const secaoVento = criar("section", "secaoCartao");
    secaoVento.append(criar("h3", "", "Vento"));
    secaoVento.append(criar("p", "", vento && Number.isFinite(vento.direcaoDeGraus)
      ? `${ponto(vento.direcaoDeGraus)} · ${Math.round(vento.velocidadeKmh)} km/h (rajadas ${Math.round(vento.rajadaKmh)} km/h) · umidade ${vento.umidade}%`
      : "Dados de vento indisponíveis."));
    painel.append(secaoVento);
    const secaoFocos = criar("section", "secaoCartao");
    secaoFocos.append(criar("h3", "", `Focos ${AreaGeo.ehImovel(area) ? "na área monitorada" : "no raio"} (${analise.total})`));
    const lista = criar("div", "listaFocos");
    for (const item of (analise.dentro || []).slice(0, 5)) {
      const f = item.f;
      const b = criar("button", "itemFoco");
      b.type = "button";
      const pontoCor = criar("i", "pontoCor");
      const cor = corFoco(f);
      pontoCor.style.backgroundColor = cor;
      pontoCor.style.color = cor;
      if (f.confirmacoes >= 2 && !f.somenteGeo) pontoCor.classList.add("losango");
      const textoItem = criar("span");
      textoItem.append(document.createTextNode(`${AreaGeo.descreverDistancia(area, item.km)}${item.dentroImovel ? "" : ` · ${ponto(item.rumo)}`} `));
      const satelites = f.satelites || (f.satelite ? [f.satelite] : []);
      const geoestacionarios = satelites.filter((s) => /GOES|MSG/i.test(s));
      const confirmacao = `polares: ${f.confirmacoes || 0}${f.confirmacoes >= 2 ? " (confirmado)" : ""}`;
      const geoTexto = geoestacionarios.length ? ` · geoestacionários: ${geoestacionarios.join(", ")}` : "";
      textoItem.append(criar("small", "", `Observado ${formatarIdade(idadeMinutos(f))} · ${confirmacao}${geoTexto}`));
      b.append(pontoCor, textoItem);
      b.addEventListener("click", () => destacarFoco(f));
      lista.append(b);
    }
    if (!analise.total) lista.append(criar("p", "vazio", "Nenhum foco detectado no raio."));
    if (analise.total > 5) lista.append(botao(`Ver todos (${analise.total})`, () => {
      mapa.fitBounds(limitesArea(area).pad(.2));
    }));
    secaoFocos.append(lista);
    painel.append(secaoFocos);
    const dados = criar("section", "secaoCartao");
    dados.append(criar("h3", "", "Dados da área"));
    if (AreaGeo.ehImovel(area)) {
      dados.append(criarLinhaDado("Tipo", "Imóvel (shapefile)"));
      if (Number.isFinite(area.hectares)) dados.append(criarLinhaDado("Área do imóvel", `${Math.round(area.hectares).toLocaleString("pt-BR")} ha`));
      dados.append(criarLinhaDado("Folga monitorada", `${area.folga} km em volta do limite`));
      dados.append(criarLinhaDado("Centro", `${area.lat.toFixed(4)}, ${area.lon.toFixed(4)}`));
    } else {
      dados.append(criarLinhaDado("Coordenadas", `${area.lat.toFixed(4)}, ${area.lon.toFixed(4)}`));
      dados.append(criarLinhaDado("Raio", `${area.raio} km`));
      if (area.raio > 50) dados.append(criar("p", "areaGrande", "Raio grande: os alertas ficam menos precisos."));
    }
    dados.append(criarLinhaDado("Webhook", area.webhookConfigurado ? "Configurado" : "Não configurado"));
    painel.append(dados);
    const acoes = criar("div", "acoesCartao");
    acoes.append(botao("Centralizar", () => mapa.flyToBounds(limitesArea(area), { padding: [40, 40], maxZoom: 12 })));
    const imagem = criar("a", "botaoAcao", "Ver imagem");
    imagem.href = `/api/areas/${encodeURIComponent(area.id)}/imagem`;
    imagem.target = "_blank"; imagem.rel = "noopener";
    acoes.append(imagem);
    const teste = botao("Testar webhook", async (evento) => {
      evento.currentTarget.disabled = true;
      resultado.textContent = "Enviando…";
      try {
        const r = await jsonPost(`/api/areas/${encodeURIComponent(area.id)}/testar-webhook`);
        resultado.textContent = `Enviado (nível: ${ROTULO[r.nivel] || r.nivel})`;
      } catch (e) { resultado.textContent = `Falhou: ${e.message}`; resultado.className = "erro"; }
      finally { evento.currentTarget.disabled = !area.webhookConfigurado; }
    });
    teste.disabled = !area.webhookConfigurado;
    acoes.append(teste);
    const remover = botao("Remover", () => confirmarRemocao(area, remover));
    acoes.append(remover);
    painel.append(acoes);
    const resultado = criar("p", "estado");
    painel.append(resultado);
    $("painelArea").hidden = false;
  }
  async function confirmarRemocao(area, controle) {
    if (remocaoPendente !== area.id) {
      remocaoPendente = area.id;
      controle.textContent = "Confirmar remoção";
      setTimeout(() => {
        if (remocaoPendente === area.id) {
          remocaoPendente = null;
          if (controle.isConnected) controle.textContent = "Remover";
        }
      }, 5000);
      return;
    }
    remocaoPendente = null;
    try {
      const r = await fetch(`/api/areas/${encodeURIComponent(area.id)}`, { method: "DELETE" });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.erro || `Erro ${r.status}`);
      delete analises[area.id]; delete ventos[area.id];
      areaSelecionada = null; $("painelArea").hidden = true;
      await carregarAreas(); renderTudo(); atualizar();
    } catch (e) { mostrarErro(`Falha ao remover área: ${e.message}`); }
  }
  function fecharPainel(restaurarFoco = false) {
    $("painelArea").hidden = true;
    areaSelecionada = null;
    desenharAreas();
    if (restaurarFoco) {
      if (focoAnteriorPainel && focoAnteriorPainel.isConnected && !focoAnteriorPainel.closest("[hidden]")) {
        focoAnteriorPainel.focus({ preventScroll: true });
      } else {
        $("botaoAreas").focus();
      }
    }
    focoAnteriorPainel = null;
  }
  function fecharMenus() {
    $("menuAreas").hidden = true; $("menuFiltros").hidden = true;
    $("botaoAreas").setAttribute("aria-expanded", "false");
    $("botaoFiltros").setAttribute("aria-expanded", "false");
  }
  function alternarMenu(botaoMenu, menu) {
    const abrir = menu.hidden;
    fecharMenus();
    if (abrir) {
      if (!$("painelArea").hidden) fecharPainel();
      if (!$("cartaoNova").hidden) fecharNovaArea();
      menu.hidden = false;
      botaoMenu.setAttribute("aria-expanded", "true");
    }
    else botaoMenu.focus();
  }
  function desenharListaAreas() {
    const lista = $("listaAreas");
    lista.replaceChildren();
    atualizarEstadoSemAreas();
    if (!areasCarregadas) { lista.append(criar("p", "vazio", "Não foi possível carregar as áreas.")); return; }
    if (!areas.length) { lista.append(criar("p", "vazio", "Nenhuma área monitorada. Use + Nova área.")); return; }
    for (const area of areas) {
      const an = analises[area.id] || { nivel: "ok" };
      const b = criar("button", `itemArea ${an.nivel}`);
      b.type = "button";
      b.append(criar("span", `selo ${an.nivel}`, ROTULO[an.nivel]), document.createTextNode(` ${area.nome}`));
      b.addEventListener("click", () => { abrirPainel(area); selecionarArea(area); });
      lista.append(b);
    }
  }
  function atualizarEstadoSemAreas() {
    $("semAreas").hidden = !areasCarregadas || areas.length > 0 || !$("cartaoNova").hidden || modoEscolha;
  }
  function desenharPainel() {
    desenharListaAreas();
    if (areaSelecionada) desenharPainelArea();
  }

  function desenharPorSatelite() {
    const el = $("porSatelite");
    el.replaceChildren();
    for (const s of fontes) {
      const nome = criar("span", s.erro ? "erro" : "", s.satelite);
      const total = s.modo === "off" ? "desativado"
        : s.erro ? `erro (${s.erro})`
          : s.modo === "observar" ? `${s.total} · observação`
            : `${s.total}${s.total === 0 ? " (nenhuma)" : ""}`;
      const valor = criar("span", "contagemFonte", total);
      if (s.erro) valor.classList.add("erro");
      el.append(nome, valor);
    }
  }
  function desenharLegenda() {
    $("legendaGeo").hidden = config.inpeGeo !== "on";
    const potencias = $("amostrasPotencia");
    if (!potencias.childElementCount) {
      for (const [cor, rotulo] of [
        [COR_POTENCIA.baixa, "Baixa · até 10 MW"],
        [COR_POTENCIA.media, "Média · 10 a 50 MW"],
        [COR_POTENCIA.alta, "Alta · acima de 50 MW"],
      ]) {
        const item = criar("span", "potenciaLegenda");
        const amostra = criar("span", "amostraFoco");
        amostra.append(criarAmostraFoco(cor));
        item.append(amostra, document.createTextNode(rotulo));
        potencias.append(item);
      }
      $("amostraUmSat").append(criarAmostraFoco(COR_POTENCIA.media));
      $("amostraMultiSat").append(criarAmostraFoco(COR_POTENCIA.media, { confirmado: true }));
      $("amostraGeo").append(criarAmostraFoco(COR_POTENCIA.geo, { geo: true }));
      const idade = $("amostrasIdade");
      for (const [opacidade, rotulo] of [
        [OPACIDADE_IDADE.recente, "Até 3 h"],
        [OPACIDADE_IDADE.media, "3 a 12 h"],
        [OPACIDADE_IDADE.antiga, "12 a 24 h"],
      ]) {
        const item = criar("span", "idadeItem");
        const pontoIdade = criar("i", "pontoIdade");
        pontoIdade.style.setProperty("--opacidade-amostra", String(opacidade));
        pontoIdade.style.setProperty("--cor-amostra", COR_POTENCIA.media);
        item.append(pontoIdade, document.createTextNode(rotulo));
        idade.append(item);
      }
      for (const anel of document.querySelectorAll(".areaLegenda")) {
        anel.style.setProperty("--cor-area", COR[anel.dataset.nivel]);
      }
      const vento = $("legenda").querySelector(".amostraVento path");
      vento.setAttribute("fill", COR_VENTO);
    }
  }
  function renderTudo() {
    sincronizarFocos();
    desenharAreas();
    desenharPainel();
    desenharLegenda();
    atualizarContadorFiltros();
    atualizarIndicadorAreas();
  }
  function atualizarContadorFiltros() {
    let ativos = 0;
    if ($("fonte").value !== "todos") ativos++;
    if ($("dias").value !== "1") ativos++;
    if (Number($("confianca").value) !== (NIVEL_CONF[config.confiancaMinima] ?? 1)) ativos++;
    if ($("confirma").value !== "1") ativos++;
    if (!$("mostrarGeo").checked) ativos++;
    const indicador = $("indicadorFiltros");
    indicador.hidden = ativos === 0;
    indicador.textContent = String(ativos);
    const rotulo = ativos ? `Filtros, ${ativos} ${ativos === 1 ? "filtro ativo" : "filtros ativos"}` : "Filtros";
    $("botaoFiltros").setAttribute("aria-label", rotulo);
    $("botaoFiltros").title = rotulo;
  }
  function atualizarIndicadorAreas() {
    const niveis = areas.map((area) => (analises[area.id] || { nivel: "ok" }).nivel);
    const alertas = niveis.filter((nivel) => nivel === "alto").length;
    const atencoes = niveis.filter((nivel) => nivel === "atencao").length;
    const indicador = $("indicadorAreas");
    indicador.classList.toggle("alto", alertas > 0);
    indicador.classList.toggle("atencao", alertas === 0 && atencoes > 0);
    indicador.hidden = alertas === 0 && atencoes === 0;
    const detalhe = alertas > 0 ? `${alertas} ${alertas === 1 ? "área em alerta" : "áreas em alerta"}`
      : atencoes > 0 ? `${atencoes} ${atencoes === 1 ? "área em atenção" : "áreas em atenção"}` : "";
    $("botaoAreas").setAttribute("aria-label", detalhe ? `Áreas, ${detalhe}` : "Áreas");
    $("botaoAreas").title = detalhe ? `Áreas, ${detalhe}` : "Áreas";
  }
  function aplicarFiltro() {
    const minConf = Number($("confianca").value), minSat = Number($("confirma").value);
    focos = todosFocos.filter((f) =>
      NIVEL_CONF[f.confianca] >= minConf
      && (f.somenteGeo ? $("mostrarGeo").checked : f.confirmacoes >= minSat)
    );
  }
  function reanalisar() {
    aplicarFiltro();
    for (const a of areas) analises[a.id] = analisar(a);
    renderTudo();
    resumo();
  }
  function resumo() {
    const substantivo = focos.length === 1 ? "foco" : "focos";
    let texto = `${focos.length.toLocaleString("pt-BR")} ${substantivo}`;
    texto += ultimaAtualizacao ? ` · atualizado às ${ultimaAtualizacao}` : " · sem atualização recente";
    const ocultos = resultadoZoom.ocultosPorZoom + resultadoZoom.ocultosPorTeto;
    if (ocultos > 0) texto += ` · ${ocultos.toLocaleString("pt-BR")} fora do desenho neste zoom`;
    if (omitidosServidor > 0) texto += ` · servidor omitiu ${omitidosServidor.toLocaleString("pt-BR")} de menor relevância (MAX_FOCOS_RESPOSTA)`;
    $("estado").textContent = texto;
  }
  function mostrarErro(texto) {
    const status = $("estadoMapa");
    status.replaceChildren();
    status.hidden = false;
    status.className = "estadoMapa erro";
    status.append(criar("span", "mensagemStatus", texto.startsWith("Falha") ? texto : `Falha ao buscar dados: ${texto}`));
    status.append(botao("Tentar de novo", atualizar));
    status.append(botao("×", () => { status.hidden = true; }, "fecharStatus"));
    status.lastElementChild.setAttribute("aria-label", "Fechar aviso");
    status.lastElementChild.title = "Fechar aviso";
  }
  async function carregarSaude() {
    try {
      saude = await json("/api/saude");
      const semChave = typeof saude.modo === "string" && saude.modo.startsWith("arquivos sem chave");
      for (const opcao of $("dias").options) {
        if (Number(opcao.value) > 1) opcao.disabled = semChave;
      }
      $("dicaPeriodo").hidden = !semChave;
    } catch {
      saude = null;
    }
  }
  async function atualizar() {
    $("botaoFiltros").classList.add("carregando");
    $("atualizar").classList.add("carregando");
    $("atualizar").disabled = true;
    try {
      const r = await json(`/api/focos?fonte=${encodeURIComponent($("fonte").value)}&dias=${encodeURIComponent($("dias").value)}`);
      todosFocos = r.focos;
      omitidosServidor = r.omitidos || 0;
      fontes = r.fontes || [];
      desenharPorSatelite();
      const resultadosVento = await Promise.all(areas.map(async (a) => {
        try { return [a.id, await json(`/api/vento?lat=${a.lat}&lon=${a.lon}`)]; }
        catch { return [a.id, null]; }
      }));
      for (const [id, vento] of resultadosVento) if (vento) ventos[id] = vento;
      reanalisar();
      ultimaAtualizacao = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Cuiaba" });
      resumo();
      $("estadoMapa").hidden = true;
    } catch (e) {
      mostrarErro(e.message);
    } finally {
      $("botaoFiltros").classList.remove("carregando");
      $("atualizar").classList.remove("carregando");
      $("atualizar").disabled = false;
    }
  }

  function abrirNovaArea() {
    fecharMenus(); fecharPainel();
    $("erroForm").textContent = "";
    $("cartaoNova").hidden = false;
    $("botaoNova").setAttribute("aria-expanded", "true");
    atualizarEstadoSemAreas();
    $("nome").focus();
  }
  function fecharNovaArea() {
    $("cartaoNova").hidden = true;
    $("botaoNova").setAttribute("aria-expanded", "false");
    if (modoEscolha) cancelarEscolha();
    atualizarEstadoSemAreas();
    $("botaoNova").focus();
  }
  function limparTemporarios() {
    camadaTemporaria.clearLayers();
    marcaTemp = null;
    preVisualizacao = null;
  }
  function atualizarPrevia() {
    if (!preVisualizacao) return;
    camadaTemporaria.clearLayers();
    if (preVisualizacao.imovel) {
      const folga = Number($("folga").value);
      camadasImovel({ ...preVisualizacao.imovel, folga: Number.isFinite(folga) && folga >= 0 ? folga : 0 }, {
        color: "#1f6fb2", weight: 2, fillColor: "#1f6fb2", fillOpacity: .25, opacidadeFolga: .12, interactive: false,
      }, camadaTemporaria);
      return;
    }
    const lat = preVisualizacao.lat, lon = preVisualizacao.lon;
    const raio = Number($("raio").value);
    if (Number.isFinite(raio) && raio > 0) {
      L.circle([lat, lon], { renderer, radius: raio * 1000, color: "#1f6fb2", weight: 2, fillOpacity: .08, interactive: false }).addTo(camadaTemporaria);
    }
    marcaTemp = L.circleMarker([lat, lon], { renderer, radius: 7, color: "#1f6fb2", weight: 2, fillOpacity: .3, interactive: false }).addTo(camadaTemporaria);
  }
  function iniciarEscolha() {
    modoEscolha = true;
    $("cartaoNova").hidden = true;
    atualizarEstadoSemAreas();
    $("faixaEscolha").hidden = false;
    mapa.getContainer().style.cursor = "crosshair";
  }
  function cancelarEscolha() {
    modoEscolha = false;
    $("faixaEscolha").hidden = true;
    mapa.getContainer().style.cursor = "";
    atualizarEstadoSemAreas();
  }
  function escolherPonto(latlng) {
    $("lat").value = latlng.lat.toFixed(4);
    $("lon").value = latlng.lng.toFixed(4);
    preVisualizacao = { lat: latlng.lat, lon: latlng.lng };
    cancelarEscolha();
    atualizarPrevia();
    $("cartaoNova").hidden = false;
    atualizarEstadoSemAreas();
    $("lat").focus();
  }

  // ---------- cadastro por shapefile ----------
  let modoImovel = false;
  let imovelLido = null; // { partes, hectares, ... } do arquivo escolhido
  function definirModoCadastro(imovel) {
    modoImovel = imovel;
    $("modoPonto").classList.toggle("ativo", !imovel);
    $("modoImovel").classList.toggle("ativo", imovel);
    $("modoPonto").setAttribute("aria-pressed", String(!imovel));
    $("modoImovel").setAttribute("aria-pressed", String(imovel));
    $("blocoPonto").hidden = imovel;
    $("blocoImovel").hidden = !imovel;
    // campos escondidos ficam desabilitados para não bloquear o envio do formulário
    for (const id of ["lat", "lon", "raio"]) $(id).disabled = imovel;
    $("folga").disabled = !imovel;
    $("escolherLocal").hidden = imovel;
    limparTemporarios();
    $("erroForm").textContent = "";
    if (imovel && imovelLido) mostrarPreviaImovel();
    else if (!imovel) { preVisualizacao = null; if (Number.isFinite(parseFloat($("lat").value))) preVisualizacao = { lat: parseFloat($("lat").value), lon: parseFloat($("lon").value) }; atualizarPrevia(); }
  }
  function resumoImovel(texto, erro = false) {
    const el = $("resumoImovel");
    el.hidden = !texto;
    el.textContent = texto;
    el.classList.toggle("resumoImovelErro", erro);
  }
  function mostrarPreviaImovel() {
    const resumo = AreaGeo.resumirPartes(imovelLido.partes);
    preVisualizacao = { imovel: { lat: resumo.lat, lon: resumo.lon, partes: imovelLido.partes } };
    atualizarPrevia();
    const folga = Math.max(0, Number($("folga").value) || 0);
    const d = folga / 111.32, dLon = folga / (111.32 * Math.cos(resumo.lat * RAD));
    mapa.fitBounds([[resumo.bbox.s - d, resumo.bbox.w - dLon], [resumo.bbox.n + d, resumo.bbox.e + dLon]], { paddingTopLeft: [24, 90], paddingBottomRight: [mobileCartao() ? 24 : 420, mobileCartao() ? 320 : 40] });
  }
  const mobileCartao = () => matchMedia("(max-width: 800px)").matches;
  async function lerArquivosImovel(lista) {
    imovelLido = null;
    limparTemporarios();
    resumoImovel("");
    if (!lista.length) return;
    resumoImovel("Lendo o arquivo…");
    try {
      const arquivos = await Promise.all(Array.from(lista).map(async (f) => ({ name: f.name, buffer: await f.arrayBuffer() })));
      const r = await Shapefile.carregarShapefile(arquivos);
      const resumo = AreaGeo.resumirPartes(r.partes);
      imovelLido = { ...r, hectares: resumo.hectares };
      if (!$("nome").value.trim()) $("nome").value = (r.nomeSugerido || arquivos.find((a) => /\.(shp|zip)$/i.test(a.name)).name.replace(/\.(shp|zip)$/i, "").replace(/^[0-9a-f]{8}-/i, "").replace(/[_-]+/g, " ")).slice(0, 120);
      const partes = [`${r.partes.length} feição(ões)`, `≈ ${Math.round(resumo.hectares).toLocaleString("pt-BR")} ha`, `${resumo.vertices.toLocaleString("pt-BR")} vértices`];
      let texto = partes.join(" · ");
      if (r.toleranciaM) texto += ` (simplificado de ${r.verticesOriginais.toLocaleString("pt-BR")}, tolerância ${r.toleranciaM} m)`;
      if (r.avisos.length) texto += ` · ${r.avisos.join(" ")}`;
      resumoImovel(texto);
      mostrarPreviaImovel();
    } catch (e) {
      imovelLido = null;
      resumoImovel(e.message, true);
    }
  }

  // ---------- eventos ----------
  $("modoPonto").addEventListener("click", () => definirModoCadastro(false));
  $("modoImovel").addEventListener("click", () => definirModoCadastro(true));
  $("arquivoShape").addEventListener("change", (e) => lerArquivosImovel(e.target.files));
  $("folga").addEventListener("input", () => { if (modoImovel && imovelLido) atualizarPrevia(); });
  mapa.on("moveend", sincronizarFocos); // também dispara ao fim de cada zoom
  mapa.on("click", (evento) => {
    if (modoEscolha) { escolherPonto(evento.latlng); return; }
    fecharPainel();
    fecharMenus();
  });
  mapa.getContainer().addEventListener("click", (evento) => {
    if (!modoEscolha || evento.target.closest(".leaflet-control, .leaflet-popup")) return;
    evento.preventDefault();
    evento.stopImmediatePropagation();
    escolherPonto(mapa.mouseEventToLatLng(evento));
  }, true);
  $("botaoAreas").addEventListener("click", () => alternarMenu($("botaoAreas"), $("menuAreas")));
  $("botaoFiltros").addEventListener("click", () => alternarMenu($("botaoFiltros"), $("menuFiltros")));
  $("botaoNova").addEventListener("click", () => {
    if (!$("cartaoNova").hidden) fecharNovaArea();
    else abrirNovaArea();
  });
  document.querySelectorAll(".popover .fecharPainel").forEach((botaoFechar) => {
    botaoFechar.addEventListener("click", () => {
      const botaoMenu = botaoFechar.closest("#menuAreas") ? $("botaoAreas") : $("botaoFiltros");
      fecharMenus();
      botaoMenu.focus();
    });
  });
  $("atualizar").addEventListener("click", atualizar);
  $("fonte").addEventListener("change", () => { atualizarContadorFiltros(); atualizar(); });
  $("dias").addEventListener("change", () => { atualizarContadorFiltros(); atualizar(); });
  $("confianca").addEventListener("change", () => { reanalisar(); resumo(); atualizarContadorFiltros(); });
  $("confirma").addEventListener("change", () => { reanalisar(); resumo(); atualizarContadorFiltros(); });
  $("mostrarGeo").addEventListener("change", () => { reanalisar(); resumo(); atualizarContadorFiltros(); });
  $("restaurarFiltros").addEventListener("click", () => {
    $("fonte").value = "todos";
    $("dias").value = "1";
    $("confianca").value = String(NIVEL_CONF[config.confiancaMinima] ?? 1);
    $("confirma").value = "1";
    $("mostrarGeo").checked = true;
    atualizarContadorFiltros();
    atualizar();
  });
  function definirLegenda(aberta) {
    const legenda = $("legenda");
    legenda.classList.toggle("aberta", aberta);
    legenda.classList.toggle("recolhida", !aberta);
    $("botaoLegenda").setAttribute("aria-expanded", String(aberta));
    $("botaoLegenda").setAttribute("aria-label", "Recolher legenda");
    $("abrirLegenda").setAttribute("aria-expanded", String(aberta));
  }
  $("botaoLegenda").addEventListener("click", () => {
    definirLegenda(false);
    $("abrirLegenda").focus();
  });
  $("abrirLegenda").addEventListener("click", () => {
    definirLegenda(true);
    $("botaoLegenda").focus();
  });
  $("escolherLocal").addEventListener("click", iniciarEscolha);
  document.querySelectorAll("[data-fechar-nova]").forEach((b) => b.addEventListener("click", fecharNovaArea));
  $("raio").addEventListener("input", () => {
    $("avisoRaio").hidden = Number($("raio").value) <= 50;
    atualizarPrevia();
  });
  document.addEventListener("pointerdown", (evento) => {
    if (!evento.target.closest(".popover") && !evento.target.closest(".acoesTopo")) fecharMenus();
  });
  document.addEventListener("keydown", (evento) => {
    if (evento.key !== "Escape") return;
    if (document.querySelector(".leaflet-popup")) { mapa.closePopup(); }
    else if (modoEscolha) {
      cancelarEscolha();
      $("cartaoNova").hidden = false;
      atualizarEstadoSemAreas();
      $("escolherLocal").focus();
    }
    else if (!$("menuAreas").hidden || !$("menuFiltros").hidden) {
      const botaoFoco = !$("menuFiltros").hidden ? $("botaoFiltros") : $("botaoAreas");
      fecharMenus(); botaoFoco.focus();
    }
    else if (!$("painelArea").hidden) { fecharPainel(true); }
    else if (!$("cartaoNova").hidden) fecharNovaArea();
    else if ($("legenda").classList.contains("aberta")) {
      definirLegenda(false);
    }
  });
  $("form").addEventListener("submit", async (evento) => {
    evento.preventDefault();
    const erro = $("erroForm");
    erro.textContent = "";
    if (modoImovel) return enviarImovel(erro);
    const lat = parseFloat($("lat").value.replace(",", "."));
    const lon = parseFloat($("lon").value.replace(",", "."));
    const raio = Number($("raio").value);
    $("avisoRaio").hidden = raio <= 50;
    if (!Number.isFinite(raio) || raio <= 0 || raio > 500) { erro.textContent = "O raio deve ser maior que 0 e no máximo 500 km."; return; }
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) { erro.textContent = "Latitude ou longitude inválida."; return; }
    if (lat < LIMITES[0][0] || lat > LIMITES[1][0] || lon < LIMITES[0][1] || lon > LIMITES[1][1]) { erro.textContent = "Esse ponto está fora da região monitorada."; return; }
    const submit = $("form").querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      await jsonPost("/api/areas", {
        nome: $("nome").value.trim(), lat, lon, raio, webhookUrl: $("webhookUrl").value.trim(),
      });
      const nome = $("nome").value.trim();
      $("form").reset(); $("raio").value = "25"; limparTemporarios();
      $("cartaoNova").hidden = true;
      $("botaoNova").setAttribute("aria-expanded", "false");
      await carregarAreas();
      atualizarEstadoSemAreas();
      const nova = areas.find((a) => a.nome === nome && Math.abs(a.lat - lat) < .00001 && Math.abs(a.lon - lon) < .00001);
      if (nova) areaSelecionada = nova.id;
      await atualizar();
      if (nova) { abrirPainel(nova); selecionarArea(nova); }
    } catch (e) { erro.textContent = `Não deu para salvar a área: ${e.message}`; }
    finally { submit.disabled = false; }
  });

  async function enviarImovel(erro) {
    const folga = Number($("folga").value);
    if (!imovelLido) { erro.textContent = "Escolha o arquivo do imóvel (.shp)."; return; }
    if (!Number.isFinite(folga) || folga < 0 || folga > 50) { erro.textContent = "A folga deve estar entre 0 e 50 km."; return; }
    const submit = $("form").querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      const nova = await jsonPost("/api/areas", { nome: $("nome").value.trim(), folga, partes: imovelLido.partes, webhookUrl: $("webhookUrl").value.trim() });
      $("form").reset(); $("raio").value = "25"; $("folga").value = "5";
      imovelLido = null; resumoImovel(""); limparTemporarios();
      definirModoCadastro(false);
      $("cartaoNova").hidden = true;
      $("botaoNova").setAttribute("aria-expanded", "false");
      await carregarAreas();
      atualizarEstadoSemAreas();
      const criada = areas.find((a) => a.id === nova.id);
      if (criada) areaSelecionada = criada.id;
      await atualizar();
      if (criada) { abrirPainel(criada); selecionarArea(criada); }
    } catch (e) { erro.textContent = `Não deu para salvar a área: ${e.message}`; }
    finally { submit.disabled = false; }
  }

  (async () => {
    definirLegenda(!matchMedia("(max-width: 800px), (max-height: 699px)").matches);
    await carregarConfig();
    carregarContornoRegiao(); // em paralelo: não atrasa áreas e focos
    await migrarAreasAntigas();
    try { await carregarAreas(); }
    catch (e) { mostrarErro(e.message); }
    await carregarSaude();
    renderTudo();
    await atualizar();
  })();
  setInterval(atualizar, 10 * 60 * 1000);
})();
