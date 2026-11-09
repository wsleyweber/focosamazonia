// Cada arquivo de teste roda em um processo próprio, então dá para definir o ambiente antes do require.
process.env.BASIC_AUTH_USER = "operador";
process.env.BASIC_AUTH_PASS = "senha:com:dois-pontos";
process.env.DATA_DIR = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "fogo-auth-"));

const test = require("node:test");
const assert = require("node:assert/strict");
const { servidor } = require("../server");

const basic = (u, p) => "Basic " + Buffer.from(`${u}:${p}`).toString("base64");
let base;

test.before(async () => {
  await new Promise((resolve) => servidor.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${servidor.address().port}`;
});
test.after(() => servidor.close());

test("sem credenciais: 401 com WWW-Authenticate, na API e no site", async () => {
  for (const rota of ["/api/config", "/api/areas", "/"]) {
    const r = await fetch(base + rota);
    assert.equal(r.status, 401, rota);
    assert.match(r.headers.get("www-authenticate") || "", /^Basic realm=/, rota);
  }
});

test("rotas que alteram áreas também exigem credenciais", async () => {
  const r = await fetch(base + "/api/areas", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nome: "x", lat: -13, lon: -55, raio: 5 }),
  });
  assert.equal(r.status, 401);
  const d = await fetch(base + "/api/areas/qualquer", { method: "DELETE" });
  assert.equal(d.status, 401);
});

test("credenciais erradas: 401", async () => {
  for (const h of [basic("operador", "errada"), basic("outro", "senha:com:dois-pontos"), "Basic !!!", "Bearer abc", basic("operador", "")]) {
    const r = await fetch(base + "/api/config", { headers: { Authorization: h } });
    assert.equal(r.status, 401, h);
  }
});

test("credenciais corretas (senha com dois-pontos): acesso liberado", async () => {
  const h = { Authorization: basic("operador", "senha:com:dois-pontos") };
  const r = await fetch(base + "/api/config", { headers: h });
  assert.equal(r.status, 200);
  const s = await fetch(base + "/", { headers: h });
  assert.equal(s.status, 200);
});

test("/api/saude sem credenciais só informa que está de pé; com credenciais mostra os detalhes", async () => {
  const sem = await (await fetch(base + "/api/saude")).json();
  assert.deepEqual(sem, { ok: true });
  const com = await (await fetch(base + "/api/saude", { headers: { Authorization: basic("operador", "senha:com:dois-pontos") } })).json();
  assert.equal(com.ok, true);
  assert.ok("monitor" in com && "regiao" in com);
});
