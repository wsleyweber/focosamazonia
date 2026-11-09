const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const armazenamento = require("../lib/armazenamento");

test("DATA_DIR muda a pasta de dados, e ela é criada se não existir", () => {
  const anterior = process.env.DATA_DIR;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "fogo-dados-"));
  const destino = path.join(base, "volume", "dados");
  process.env.DATA_DIR = destino;
  try {
    assert.equal(armazenamento.diretorioDados(), destino);
    armazenamento.salvarAreas([{ id: "a1", nome: "Teste" }]);
    armazenamento.salvarEstado({ a1: { nivel: "ok" } });
    assert.ok(fs.existsSync(path.join(destino, "areas.json")));
    assert.deepEqual(armazenamento.listarAreas(), [{ id: "a1", nome: "Teste" }]);
    assert.deepEqual(armazenamento.lerEstado(), { a1: { nivel: "ok" } });
  } finally {
    if (anterior === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = anterior;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("sem DATA_DIR, usa a pasta dados/ do projeto", () => {
  const anterior = process.env.DATA_DIR;
  delete process.env.DATA_DIR;
  try {
    assert.equal(armazenamento.diretorioDados(), path.join(__dirname, "..", "dados"));
  } finally {
    if (anterior !== undefined) process.env.DATA_DIR = anterior;
  }
});
