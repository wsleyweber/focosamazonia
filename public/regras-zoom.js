// Quais focos o mapa desenha em cada nível de zoom. Só afeta o DESENHO: a análise das áreas (alertas,
// painel, contagens) continua usando todos os focos que passaram pelos filtros do menu.
// Sem dependência de DOM nem de Leaflet, para poder ser testado em Node (veja testes/regras-zoom.test.js).
(function (raiz) {
  // Mesmos limites de potência da legenda: média > 10 MW, alta > 50 MW.
  const MW_MEDIA = 10;
  const MW_ALTA = 50;
  // Ajuste os zooms de corte olhando o mapa real na época seca; são pontos de partida, não medidas.
  // Zoom Leaflet (mapa do Brasil inteiro cabe em ~4-5; um município inteiro em ~10-11).
  // `maximo` = teto de marcadores desenhados ao mesmo tempo (só do que está na tela). Acima dele ficam os mais
  // relevantes. Existe porque "confirmado" pode ser uma fatia grande dos focos (vários satélites passam sobre o mesmo
  // fogo no mesmo dia): só o filtro por zoom não garante que a mancha suma. Mais afastado = teto menor.
  const MAX_NO_MAPA = 3000;
  const REGRAS = [
    { zoomMax: 6, id: "afastado", descricao: "só focos confirmados ou de potência alta", maximo: 1500, aceita: (f) => confirmado(f) || f.frp > MW_ALTA },
    { zoomMax: 8, id: "intermediario", descricao: "só focos confirmados ou de potência média e alta", maximo: MAX_NO_MAPA, aceita: (f) => confirmado(f) || f.frp > MW_MEDIA },
    { zoomMax: Infinity, id: "proximo", descricao: "todos os focos", maximo: MAX_NO_MAPA, aceita: () => true },
  ];

  const confirmado = (f) => f.confirmacoes >= 2 && !f.somenteGeo;

  function regraParaZoom(zoom) {
    return REGRAS.find((r) => zoom <= r.zoomMax) || REGRAS[REGRAS.length - 1];
  }

  // confirmados primeiro, depois maior potência
  function porRelevancia(a, b) {
    const c = Number(confirmado(b)) - Number(confirmado(a));
    return c || (b.frp - a.frp);
  }

  /**
   * @param {Array} focos todos os focos que passaram pelos filtros do menu
   * @param {{zoom:number, limites?:{w:number,s:number,e:number,n:number}|null, maximo?:number, destacado?:object|null}} opcoes
   *        maximo = teto de marcadores; se omitido, usa o da regra do zoom
   *        limites = área visível (já com folga); sem limites, considera tudo
   * @returns {{visiveis:Array, ocultosPorZoom:number, ocultosPorTeto:number, regra:object}}
   *          contagens só do que está dentro de `limites`
   */
  function selecionarFocosVisiveis(focos, { zoom, limites = null, maximo, destacado = null }) {
    const regra = regraParaZoom(zoom);
    if (maximo === undefined) maximo = regra.maximo;
    let candidatos = [];
    let ocultosPorZoom = 0;
    for (const f of focos) {
      if (limites && !(f.lon >= limites.w && f.lon <= limites.e && f.lat >= limites.s && f.lat <= limites.n)) continue;
      if (f === destacado || regra.aceita(f)) candidatos.push(f);
      else ocultosPorZoom++;
    }
    let ocultosPorTeto = 0;
    if (maximo > 0 && candidatos.length > maximo) {
      const reservado = destacado && candidatos.includes(destacado) ? [destacado] : [];
      const resto = candidatos.filter((f) => f !== destacado).sort(porRelevancia);
      const cabe = Math.max(0, maximo - reservado.length);
      ocultosPorTeto = resto.length - Math.min(cabe, resto.length);
      candidatos = reservado.concat(resto.slice(0, cabe));
    }
    return { visiveis: candidatos, ocultosPorZoom, ocultosPorTeto, regra };
  }

  const api = { REGRAS, MAX_NO_MAPA, regraParaZoom, selecionarFocosVisiveis, confirmado };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else raiz.RegrasZoom = api;
})(typeof window !== "undefined" ? window : globalThis);
