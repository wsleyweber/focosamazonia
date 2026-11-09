const fs = require("fs");
const path = require("path");

const MINUTOS_HORA = 60 * 60 * 1000;
const HORAS_SEIS = 6 * MINUTOS_HORA;

function instanteVarredura(valor) {
  const t = Date.parse(valor);
  return Number.isFinite(t) ? t : null;
}

function horarioFocoUtc(foco) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(foco.data || "") || !/^\d{4}$/.test(foco.hora || "")) return null;
  return `${foco.data}T${foco.hora.slice(0, 2)}:${foco.hora.slice(2)}:00Z`;
}

function mediana(valores) {
  if (!valores.length) return null;
  const ordenados = valores.slice().sort((a, b) => a - b);
  const meio = Math.floor(ordenados.length / 2);
  return ordenados.length % 2
    ? ordenados[meio]
    : (ordenados[meio - 1] + ordenados[meio]) / 2;
}

function criarObservador(arquivo, dedupGeoKm, distanciaKm) {
  const registros = new Map();
  let sequencia = 0;
  let horaResumo = null;
  if (fs.existsSync(arquivo)) {
    const linhas = fs.readFileSync(arquivo, "utf8").split(/\r?\n/).filter(Boolean);
    for (const linha of linhas) {
      const registro = JSON.parse(linha);
      if (registro.id) registros.set(registro.id, registro);
    }
    sequencia = registros.size;
  }

  function salvar(linhas) {
    if (!linhas.length) return;
    fs.mkdirSync(path.dirname(arquivo), { recursive: true });
    fs.appendFileSync(arquivo, linhas.map((x) => JSON.stringify(x)).join("\n") + "\n", "utf8");
  }

  function atualizar(focosGeo, focosPolar, agora = Date.now()) {
    const isoAgora = new Date(agora).toISOString();
    const linhas = [];
    const ativos = [];
    for (const foco of focosGeo.filter((x) => x.somenteGeo)) {
      let registro = [...registros.values()]
        .filter((x) => agora - Date.parse(x.ultimoVistoEm) <= HORAS_SEIS)
        .filter((x) => distanciaKm(foco.lat, foco.lon, x.lat, x.lon) <= dedupGeoKm)
        .sort((a, b) => distanciaKm(foco.lat, foco.lon, a.lat, a.lon) - distanciaKm(foco.lat, foco.lon, b.lat, b.lon))[0];
      if (!registro) {
        sequencia++;
        registro = {
          id: `geo-${agora}-${sequencia}`,
          lat: foco.lat,
          lon: foco.lon,
          primeiroVistoEm: isoAgora,
          primeiraVarredura: (foco.varredurasGeo || [])[0] || horarioFocoUtc(foco),
          varreduras: [],
          confirmado: false,
          confirmadoEm: null,
          minutosAteConfirmacao: null,
          nuncaConfirmado6h: false,
        };
        registros.set(registro.id, registro);
      }
      registro.ultimoVistoEm = isoAgora;
      registro.lat = foco.lat;
      registro.lon = foco.lon;
      for (const varredura of foco.varredurasGeo || []) {
        if (!registro.varreduras.includes(varredura)) registro.varreduras.push(varredura);
      }
      const inicio = instanteVarredura(registro.primeiraVarredura);
      const confirmacao = focosPolar
        .filter((x) => distanciaKm(foco.lat, foco.lon, x.lat, x.lon) <= dedupGeoKm)
        .map((x) => ({ foco: x, instante: instanteVarredura(horarioFocoUtc(x)) }))
        .filter((x) => inicio != null && x.instante != null && x.instante >= inicio)
        .sort((a, b) => a.instante - b.instante)[0];
      if (!registro.confirmado && confirmacao) {
        registro.confirmado = true;
        registro.confirmadoEm = isoAgora;
        registro.minutosAteConfirmacao = Math.floor((confirmacao.instante - inicio) / 60000);
        registro.satelitesConfirmacao = confirmacao.foco.satelites || [confirmacao.foco.satelite];
      }
      ativos.push(registro);
      linhas.push({ ...registro, lidoEm: isoAgora });
    }

    for (const registro of registros.values()) {
      const inicio = instanteVarredura(registro.primeiraVarredura);
      if (!registro.confirmado && !registro.nuncaConfirmado6h && inicio != null && agora - inicio >= HORAS_SEIS) {
        registro.nuncaConfirmado6h = true;
        registro.avaliado6hEm = isoAgora;
        linhas.push({ ...registro, lidoEm: isoAgora });
      }
    }
    salvar(linhas);

    const horaAtual = new Date(agora).toISOString().slice(0, 13);
    let resumo = null;
    if (horaResumo !== horaAtual) {
      horaResumo = horaAtual;
      const todos = [...registros.values()];
      const confirmados = todos.filter((x) => x.confirmado);
      resumo = {
        focos: todos.length,
        confirmados: confirmados.length,
        medianaMinutos: mediana(confirmados.map((x) => x.minutosAteConfirmacao).filter(Number.isFinite)),
        nuncaConfirmados6h: todos.filter((x) => x.nuncaConfirmado6h).length,
      };
      console.log(
        `INPE observar: ${resumo.focos} foco(s) GOES no BBOX; ${resumo.confirmados} confirmado(s) por polar; ` +
        `mediana até confirmação: ${resumo.medianaMinutos == null ? "n/d" : resumo.medianaMinutos + " min"}; ` +
        `${resumo.nuncaConfirmados6h} sem confirmação em 6 h`
      );
    }
    return { ativos, resumo };
  }

  return { atualizar, registros };
}

module.exports = { criarObservador, mediana };
