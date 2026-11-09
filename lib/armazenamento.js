// Guarda as áreas monitoradas e o último nível de alerta de cada uma em arquivos JSON simples.
// Escrita atômica (escreve em .tmp e renomeia) para não corromper o arquivo se o processo cair no meio.
const fs = require("fs");
const path = require("path");

// DATA_DIR (opcional) aponta para outra pasta, por exemplo um volume montado em hospedagem na nuvem.
// É lido a cada uso, e não ao carregar o módulo, porque o server.js só lê o .env depois dos require.
function diretorioDados() {
  return process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, "..", "dados");
}
const arqAreas = () => path.join(diretorioDados(), "areas.json");
const arqEstado = () => path.join(diretorioDados(), "estado.json");

function garantirPasta() {
  const dir = diretorioDados();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
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
  return ler(arqAreas(), []);
}

function salvarAreas(areas) {
  escrever(arqAreas(), areas);
}

function lerEstado() {
  return ler(arqEstado(), {}); // { [idDaArea]: { nivel, em } }
}

function salvarEstado(estado) {
  escrever(arqEstado(), estado);
}

module.exports = { diretorioDados, listarAreas, salvarAreas, lerEstado, salvarEstado };
