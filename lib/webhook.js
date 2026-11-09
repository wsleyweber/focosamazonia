// Envia o alerta (texto + imagem) para a URL de webhook cadastrada na área.
// Detecta webhooks do Discord pela URL e usa o formato deles (embed com payload_json + anexo);
// qualquer outra URL recebe um multipart/form-data genérico, fácil de ler em n8n, Zapier ou servidor próprio.
const { nomePonto, idadeMinutos, formatarIdade, descreverAlcance, descreverDistancia } = require("./geo");

// Sem limite, um endpoint que não responde travaria o ciclo do monitor.
const TIMEOUT_WEBHOOK_MS = 15000;

const COR_HEX = { ok: 0x2f7d4f, atencao: 0xc77700, alto: 0xc92a2a };
const COR_MELHORA = 0x2878a0;
const ROTULO = { ok: "Sem focos", atencao: "Atenção", alto: "Alerta" };

function mensagem(area, analise, vento, motivo = "Atualização do monitor", tipo = "alerta", causa = null) {
  const rodape = "> Sem focos detectados não significa segurança: o satélite só vê em certos horários.\n> Emergência: Corpo de Bombeiros 193.";
  if (tipo === "melhora") {
    const linhas = [`**Melhora · ${area.nome}**`];
    if (causa === "focos_no_raio" && analise.maisProximo) {
      const idade = formatarIdade(idadeMinutos(analise.maisProximo.f));
      linhas.push(
        `Os ${analise.total} focos continuam no raio, mas já não estão a favor do vento (vento ou idade do foco).`,
        `Mais próximo${area.partes ? ":" : " a"} ${descreverDistancia(area, analise.maisProximo.km)}, observado ${idade}.`
      );
    } else {
      linhas.push(
        "Nenhum foco detectado nas últimas 24 h dentro do raio.",
        "Isso não confirma que o fogo apagou: o satélite só vê em certos horários e fumaça ou nuvem atrapalham."
      );
    }
    return `${linhas.join("\n\n")}\n\n${rodape}`;
  }

  const linhas = [`**${motivo}.**`];
  if (!analise.total) {
    linhas.push(`**${area.nome}**\nNenhum foco detectado ${descreverAlcance(area)}.`);
  } else {
    linhas.push(`**${area.nome}**\n${analise.total} foco(s) detectado(s) ${descreverAlcance(area)}.`);
    const detalhesFocos = [];
    for (const [i, x] of analise.dentro.slice(0, 3).entries()) {
      const f = x.f;
      const satelites = (f.satelites || (f.satelite ? [f.satelite] : [])).join(", ") || "não informado";
      const direcao = x.rumo == null ? "direção desconhecida" : nomePonto(x.rumo);
      const idadeMin = idadeMinutos(f);
      const idade = formatarIdade(idadeMin);
      const antigo = idadeMin != null && idadeMin > 12 * 60 ? " (antigo)" : "";
      const potencia = f.somenteGeo ? "n/d (só geoestacionário)" : `${Number(f.frp || 0).toFixed(1)} MW`;
      detalhesFocos.push(`**Foco ${i + 1}: ${descreverDistancia(area, x.km)}**${x.dentroImovel ? "" : `, a ${direcao}`}; observado ${idade}${antigo}; satélites: ${satelites}; confiança: ${f.confianca || "não informada"}; potência: ${potencia}${x.aFavor ? "; a favor do vento" : ""}.`);
    }
    const outros = Math.max(0, analise.total - Math.min(3, analise.total));
    if (detalhesFocos.length) linhas.push(`**Focos mais próximos**\n${detalhesFocos.join("\n")}`);
    if (outros) linhas.push(`+ ${outros} outro(s) foco(s) no raio.`);
    if (analise.confirmados) linhas.push(`Confirmados por 2 ou mais satélites: **${analise.confirmados}**.`);
  }
  if (vento && Number.isFinite(vento.direcaoDeGraus)) {
    const orientacao = !analise.dentro.length
      ? "sem focos no raio para avaliar a direção"
      : analise.dentro.some((x) => x.aFavor)
        ? "sopra dos focos para a área"
        : "sopra para longe dos focos";
    linhas.push(
      `**Vento**\n${nomePonto(vento.direcaoDeGraus)} · ${Math.round(vento.velocidadeKmh || 0)} km/h · ` +
      `rajadas ${Math.round(vento.rajadaKmh || 0)} km/h\n${orientacao}.`
    );
  } else {
    linhas.push("**Vento**\nDados indisponíveis.");
  }
  const corpo = linhas.join("\n\n");
  const limiteCorpo = 3900 - rodape.length - 1;
  return `${corpo.length > limiteCorpo ? corpo.slice(0, limiteCorpo - 3) + "..." : corpo}\n\n${rodape}`;
}

function montarCorpoMultipart(campos, arquivo) {
  const fronteira = "----monitorfocosmt" + Date.now().toString(36);
  const partes = [];
  for (const [chave, valor] of Object.entries(campos)) {
    partes.push(
      Buffer.from(`--${fronteira}\r\nContent-Disposition: form-data; name="${chave}"\r\n\r\n${valor}\r\n`)
    );
  }
  partes.push(
    Buffer.from(`--${fronteira}\r\nContent-Disposition: form-data; name="${arquivo.campo}"; filename="${arquivo.nome}"\r\nContent-Type: image/png\r\n\r\n`),
    arquivo.dados,
    Buffer.from(`\r\n--${fronteira}--\r\n`)
  );
  return { corpo: Buffer.concat(partes), tipo: `multipart/form-data; boundary=${fronteira}` };
}

async function enviarWebhook(area, analise, vento, imagemPng, motivo, tipo = "alerta", causa = null) {
  const url = area.webhookUrl;
  const texto = mensagem(area, analise, vento, motivo, tipo, causa);
  const ehDiscord = /discord(app)?\.com\/api\/webhooks/.test(url);

  let resp;
  if (ehDiscord) {
    const payload = {
      embeds: [{
        title: (tipo === "melhora" ? `Melhora · ${area.nome}` : `${ROTULO[analise.nivel]} · ${area.nome}`).slice(0, 256),
        description: texto,
        footer: { text: "Monitor de Focos - MT" },
        color: tipo === "melhora" ? COR_MELHORA : COR_HEX[analise.nivel],
        timestamp: new Date().toISOString(),
        image: { url: "attachment://area.png" },
      }],
    };
    const { corpo, tipo: tipoMultipart } = montarCorpoMultipart(
      { payload_json: JSON.stringify(payload) },
      { campo: "files[0]", nome: "area.png", dados: imagemPng }
    );
    resp = await fetch(url, { method: "POST", headers: { "Content-Type": tipoMultipart }, body: corpo, signal: AbortSignal.timeout(TIMEOUT_WEBHOOK_MS) });
  } else {
    const dados = {
      area: area.nome,
      tipo_area: area.partes ? "imovel" : "circulo",
      folga_km: area.partes ? area.folga : undefined,
      nivel: analise.nivel,
      tipo,
      mensagem: texto,
      motivo: motivo || "Atualização do monitor",
      emergencia: "193",
      total_focos: analise.total,
      confirmados: analise.confirmados,
      vento,
      focos: analise.dentro.map((x) => ({
        lat: x.f.lat,
        lon: x.f.lon,
        km: Number(x.km.toFixed(2)), // círculo: distância ao centro; imóvel: distância ao limite (0 = dentro)
        rumo: x.rumo,
        direcao: x.rumo == null ? null : nomePonto(x.rumo),
        idade_min: idadeMinutos(x.f),
        satelites: x.f.satelites || (x.f.satelite ? [x.f.satelite] : []),
        a_favor_do_vento: !!x.aFavor,
        frp: x.f.frp,
        confianca: x.f.confianca,
        confirmacoes: x.f.confirmacoes,
      })),
      em: new Date().toISOString(),
    };
    const { corpo, tipo: tipoMultipart } = montarCorpoMultipart(
      { payload: JSON.stringify(dados) },
      { campo: "imagem", nome: "area.png", dados: imagemPng }
    );
    resp = await fetch(url, { method: "POST", headers: { "Content-Type": tipoMultipart }, body: corpo, signal: AbortSignal.timeout(TIMEOUT_WEBHOOK_MS) });
  }
  if (!resp.ok) throw new Error(`webhook respondeu ${resp.status}`);
}

module.exports = { enviarWebhook, mensagem };
