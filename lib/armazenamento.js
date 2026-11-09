// Guarda as áreas monitoradas e o último nível de alerta de cada uma em arquivos JSON simples.
// Escrita atômica (escreve em .tmp e renomeia) para não corromper o arquivo se o processo cair no meio.
const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "..", "dados");
const ARQ_AREAS = path.join(DIR, "areas.json");
const ARQ_ESTADO = path.join(DIR, "estado.json");

function garantirPasta() {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
}

function ler(arquivo, padrao) {
  try {
    return JSON.parse(fs.readFileSync(arquivo, "utf8"));
  } catch {
    return padrao;
  }
}

function escrever(arquivo, valor) {
  garantirPasta();
  const tmp = arquivo + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(valor, null, 2));
  fs.renameSync(tmp, arquivo);
}

function listarAreas() {
  return ler(ARQ_AREAS, []);
}

function salvarAreas(areas) {
  escrever(ARQ_AREAS, areas);
}

function lerEstado() {
  return ler(ARQ_ESTADO, {}); // { [idDaArea]: { nivel, em } }
}

function salvarEstado(estado) {
  escrever(ARQ_ESTADO, estado);
}

module.exports = { listarAreas, salvarAreas, lerEstado, salvarEstado };
