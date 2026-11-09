// Compressão das respostas HTTP (gzip e brotli, ambos nativos do Node: nenhuma dependência nova).
// Uma resposta grande é comprimida uma única vez por codificação e guardada em memória enquanto
// o conteúdo não mudar; as requisições seguintes só enviam os bytes prontos.
const zlib = require("zlib");
const crypto = require("crypto");
const { promisify } = require("util");

const gzipAsync = promisify(zlib.gzip);
const brotliAsync = promisify(zlib.brotliCompress);

const MIN_BYTES = 1024; // abaixo disso a compressão não compensa
const LIMITE_SINCRONO = 256 * 1024; // respostas pequenas montadas na hora (json()) comprimem sem async

// Lê o cabeçalho Accept-Encoding respeitando q=0. Devolve "br", "gzip" ou null.
// Navegadores só oferecem br em HTTPS; em http://localhost chega só gzip.
function codificacaoPreferida(acceptEncoding) {
  if (!acceptEncoding) return null;
  const qs = {};
  for (const parte of String(acceptEncoding).split(",")) {
    const [nome, ...params] = parte.trim().toLowerCase().split(";");
    if (!nome) continue;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    qs[nome] = q ? Number(q.slice(2)) : 1;
  }
  const qDe = (nome) => (Number.isFinite(qs[nome]) ? qs[nome] : Number.isFinite(qs["*"]) ? qs["*"] : 0);
  const br = qDe("br"), gz = qDe("gzip");
  if (br > 0 && br >= gz) return "br";
  if (gz > 0) return "gzip";
  return null;
}

function comprimir(buffer, codificacao) {
  if (codificacao === "br") {
    return brotliAsync(buffer, {
      params: {
        // qualidade 5: boa razão para JSON/JS sem a lentidão do padrão (11), que levaria segundos
        [zlib.constants.BROTLI_PARAM_QUALITY]: 5,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buffer.length,
      },
    });
  }
  return gzipAsync(buffer, { level: 6 });
}

function comprimirSincrono(buffer, codificacao) {
  return codificacao === "br"
    ? zlib.brotliCompressSync(buffer, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } })
    : zlib.gzipSync(buffer, { level: 6 });
}

// Conteúdo que será servido várias vezes: guarda o original e cada versão comprimida (calculada sob demanda).
class CorpoComprimivel {
  constructor(buffer, tipo) {
    this.buffer = buffer;
    this.tipo = tipo;
    // ETag fraco: é o mesmo para qualquer codificação do mesmo conteúdo (RFC 9110)
    this.etag = `W/"${crypto.createHash("sha1").update(buffer).digest("base64url").slice(0, 22)}"`;
    this.versoes = new Map();
  }

  obter(codificacao) {
    if (!codificacao || this.buffer.length < MIN_BYTES) return Promise.resolve(this.buffer);
    if (!this.versoes.has(codificacao)) {
      const promessa = comprimir(this.buffer, codificacao).catch((erro) => {
        this.versoes.delete(codificacao);
        throw erro;
      });
      this.versoes.set(codificacao, promessa);
    }
    return this.versoes.get(codificacao);
  }
}

function etagCorresponde(req, etag) {
  const recebido = req.headers["if-none-match"];
  if (!recebido) return false;
  const normaliza = (v) => v.trim().replace(/^W\//, "");
  return recebido.split(",").some((v) => v.trim() === "*" || normaliza(v) === normaliza(etag));
}

/**
 * Envia um CorpoComprimivel negociando codificação, ETag/304 e HEAD.
 * @param {{status?:number, cacheControl?:string, comprimir?:boolean}} opcoes
 */
async function enviarCorpo(req, res, corpo, { status = 200, cacheControl = "no-cache", comprimir: querComprimir = true } = {}) {
  const cabecalhos = {
    "Content-Type": corpo.tipo,
    "Cache-Control": cacheControl,
    ETag: corpo.etag,
    Vary: "Accept-Encoding",
  };
  if (status === 200 && etagCorresponde(req, corpo.etag)) {
    res.writeHead(304, cabecalhos);
    return res.end();
  }
  const codificacao = querComprimir && corpo.buffer.length >= MIN_BYTES ? codificacaoPreferida(req.headers["accept-encoding"]) : null;
  const dados = await corpo.obter(codificacao);
  if (codificacao) cabecalhos["Content-Encoding"] = codificacao;
  cabecalhos["Content-Length"] = dados.length;
  res.writeHead(status, cabecalhos);
  return res.end(req.method === "HEAD" ? undefined : dados);
}

// Para respostas pequenas e dinâmicas (a API de áreas, config, vento): comprime na hora só se passar do mínimo.
function enviarBufferPequeno(res, status, tipo, buffer) {
  const cabecalhos = { "Content-Type": tipo, Vary: "Accept-Encoding" };
  let dados = buffer;
  if (buffer.length >= MIN_BYTES && buffer.length <= LIMITE_SINCRONO) {
    const codificacao = codificacaoPreferida(res.req?.headers["accept-encoding"]);
    if (codificacao) {
      dados = comprimirSincrono(buffer, codificacao);
      cabecalhos["Content-Encoding"] = codificacao;
    }
  }
  cabecalhos["Content-Length"] = dados.length;
  res.writeHead(status, cabecalhos);
  res.end(dados);
}

module.exports = {
  codificacaoPreferida, comprimir, CorpoComprimivel, enviarCorpo, enviarBufferPequeno, etagCorresponde, MIN_BYTES,
};
