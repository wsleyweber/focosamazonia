# Monitor de Focos – Amazônia
![CI](https://github.com/wsleyweber/focosamazonia/actions/workflows/ci.yml/badge.svg)

Painel para monitorar focos de incêndio na Amazônia (a região exata é definida em `assets/regiao.geojson`; veja "Região monitorada"). O mapa ocupa a tela; você cadastra áreas sob demanda, acompanha os focos e o vento e abre detalhes de cada área ao selecioná-la. Os alertas automáticos são enviados pelo webhook configurado.

> **Aviso de segurança:** este servidor **não tem autenticação**. Qualquer pessoa que alcance a porta pode listar, criar e apagar áreas e disparar webhooks. Por isso ele escuta só em `127.0.0.1` por padrão. Para acessá-lo de outra máquina, coloque-o atrás de um proxy com senha (Caddy, nginx, Cloudflare Access) ou de uma VPN (Tailscale) antes de mudar `HOST`.

> **Aviso de responsabilidade:** o painel não substitui os canais oficiais (Corpo de Bombeiros 193, INPE Queimadas). Os dados de satélite têm atraso, a ausência de focos não significa segurança e os limites de alerta são pontos de partida, não critérios técnicos validados. O software é fornecido sem garantia (veja `LICENSE`).

## Interface

- Mapa em tela cheia, sem barra superior. Três botões de ícone no canto superior direito abrem **Nova área**, **Filtros** e **Áreas**; indicadores mostram filtros alterados e o maior nível de alerta entre as áreas.
- O menu **Filtros** mostra a quantidade de focos e o horário da atualização, permite atualizar os dados e escolher satélite, período e critérios de exibição. 
- O mapa destaca o contorno da região monitorada (verde, por baixo de áreas e focos), vindo de `/api/regiao`. O retângulo usado na consulta à FIRMS não é desenhado.
- **Muitos focos:** o mapa só desenha o que está na tela e aplica uma regra por zoom. Afastado (zoom até 6): só focos confirmados ou de potência alta (> 50 MW); intermediário (7 e 8): confirmados ou de potência média e alta (> 10 MW); a partir do zoom 9, todos. Há ainda um teto de marcadores desenhados (1.500 afastado, 3.000 nos demais), e um aviso no canto superior esquerdo diz quando algo está oculto. A regra afeta **só o desenho**: níveis de alerta, painel das áreas e contagens usam sempre todos os focos. O popup de um foco é montado só quando você clica nele.
- A legenda diferencia potência (energia estimada, não o risco), confirmação e idade. Focos confirmados aparecem como losangos; focos somente geoestacionários usam contorno cinza tracejado sem sugerir potência indisponível.
- Elementos flutuantes usam superfícies brancas opacas, cantos retos e Montserrat, independentemente do tema do sistema. O mapa permanece claro; a legenda inicia recolhida em telas estreitas ou baixas.

## Como rodar

Requer Node.js 20 ou mais novo.

```bash
cd fogoamazonia
npm install               # instala o @napi-rs/canvas, usado para desenhar a imagem da área
cp .env.example .env      # opcional: coloque sua FIRMS_MAP_KEY e o webhook
node server.js
```

## Fontes de dados

- **Focos:** NASA FIRMS (VIIRS NOAA-20, VIIRS NOAA-21 e MODIS). O VIIRS Suomi NPP foi desativado no FIRMS em 02/11/2026 e não é mais usado.
  - Sem chave, o servidor usa os arquivos públicos de 24 horas da América do Sul.
  - Com `FIRMS_MAP_KEY`, usa a Area API e libera períodos de 2 a 5 dias. A chave é gratuita em https://firms.modaps.eosdis.nasa.gov/api/
- **Vento:** Open-Meteo (gratuito, sem chave).
- **GOES (opcional):** arquivos CSV públicos do INPE. A integração permanece desligada por padrão.

O servidor guarda tudo em cache por 10 minutos (`CACHE_MINUTOS`) para não estourar limites das APIs. Várias requisições com o cache vencido compartilham um único download, e a consulta à FIRMS tem timeout (`FIRMS_TIMEOUT_SEGUNDOS`).
As imagens usam uma fonte Roboto incorporada sob SIL Open Font License, para renderizar textos mesmo em containers que não tenham fontes do sistema instaladas.

## Região monitorada

A região vem de `assets/regiao.geojson`, gerado por `scripts/gerar-regiao.js` a partir de shapefiles do IBGE `files/`(Node puro, sem dependências). O servidor usa:

- o **retângulo** que envolve a região (`bbox`) para consultar a FIRMS e validar áreas novas;
- o **polígono** para enxugar o que vai ao mapa: focos fora dele (Bolívia, Peru, Cerrado fora do Mato Grosso etc.) não são enviados à página. **Foco dentro do círculo de qualquer área cadastrada é sempre enviado**, mesmo fora do polígono, e os alertas do monitor usam todos os focos do retângulo, então uma área perto da borda não perde focos.

O arquivo atual junta o **bioma Amazônia** (IBGE, Biomas 1:250.000) com o **polígono do Mato Grosso**. Para a forma oficial, baixe o limite da Amazônia Legal no site do IBGE (Geociências › Organização do território › Estrutura territorial › Amazônia Legal) e rode:

```bash
node scripts/gerar-regiao.js --camada "Limites_Amazonia_Legal_2024.shp" --nome "Amazônia Legal" --saida assets/regiao.geojson
```

O script aceita `--camada arquivo.shp[:CAMPO=VALOR]` (repetível), `--retangulo w,s,e,n`, `--tolerancia` (0,005° ≈ 550 m, padrão) e `--area-min-km2`. A simplificação reduz 344 mil vértices do bioma a cerca de 8 mil; o recorte do mapa pode errar até ~0,4 km junto à borda (medido contra o polígono original). Use `REGIAO_ARQUIVO` para apontar outro arquivo.

## Desempenho com muitos focos

- **Resposta enxuta:** `/api/focos` envia só os campos que a página usa (cerca de 170 bytes por foco contra 268 antes), com `ETag`; sem mudança nos dados a resposta é `304`.
- **Compressão:** gzip e brotli (módulo `zlib` nativo), negociados pelo `Accept-Encoding`. Cada resposta é comprimida uma vez e guardada; os arquivos de `public/` também. Navegadores só oferecem brotli em HTTPS.
- **Teto no servidor:** `MAX_FOCOS_RESPOSTA` (padrão 30000; `0` = sem teto). Acima dele ficam os confirmados e de maior potência, e a página avisa quantos foram omitidos. Focos dentro de áreas cadastradas nunca são cortados.
- **Chave FIRMS:** a Area API consulta o retângulo inteiro. A cota é de 5.000 transações por 10 minutos, muito acima do uso deste projeto (3 satélites por atualização); o que cresce é o tamanho da resposta, por isso o teto, a compressão e o timeout.

## Mescla de satélites

Por padrão o painel busca os três satélites (VIIRS NOAA-20, VIIRS NOAA-21 e MODIS) e junta os resultados. Focos a até 1,5 km um do outro (`DEDUP_KM`) viram um só, que guarda quais satélites o viram, a maior potência e a melhor confiança. Um foco visto por 2 ou mais satélites aparece no mapa com borda branca.

- A confiança do VIIRS (l/n/h) e a do MODIS (0 a 100) são unificadas em baixa, nominal e alta.
- Os filtros "Confiança mínima" e "Confirmação" controlam o que aparece e a análise visual da página, sem buscar dados de novo. O servidor usa `CONFIANCA_MINIMA` (padrão nominal) para seus alertas automáticos.
- Abaixo dos filtros, o painel mostra quantas detecções cada satélite devolveu. Se um satélite falhar ou vier vazio, os outros continuam funcionando e o erro aparece ali.
- A NASA planeja substituir o MODIS Terra e recomenda migrar para o VIIRS. Se o MODIS sair do ar, basta removê-lo da lista `FONTES_FIRMS` em `server.js`.
- Para ver um satélite isolado, escolha-o no campo "Satélite".

### GOES do INPE (experimental)

O INPE publica arquivos de focos a cada 10 minutos. A integração só aceita nomes de satélite `GOES`/`MSG`, não dispõe de FRP ou confiança reais e não conta como confirmação polar. Os pontos somente geoestacionários aparecem com contorno tracejado e texto de não confirmado; podem ser falsos positivos e têm posição menos precisa.

`INPE_GEO=off` desativa a consulta. `INPE_GEO=observar` consulta e registra os focos dentro do BBOX em `dados/observacao-geo.jsonl`, mas não os mostra no mapa nem os usa em alertas. O resumo por hora mostra volume, confirmações pelos polares e tempos de confirmação. Deixe esse modo rodar pelo menos sete dias, incluindo dias de fogo, antes de considerar ativar `on`. O projeto nunca ativa `on` automaticamente. Ao usar a fonte, recomenda-se `MONITOR_MINUTOS` entre 5 e 10.

## Áreas: ponto com raio ou imóvel 

Há dois jeitos de cadastrar uma área (botão **+**, seletor no topo do formulário):

- **Ponto e raio:** latitude, longitude e raio em km.
- **Imóvel:** envie o `.shp` do imóvel (de preferência com o `.prj` e o `.dbf`) ou um `.zip` com eles. Defina a **folga** em km (padrão 5, máximo 50): o sistema monitora os focos **dentro do imóvel e até a folga de distância do limite dele**. O mapa mostra o polígono e a faixa de folga.

O arquivo é lido no navegador (`public/shapefile.js`); o servidor só recebe e valida o polígono. Detalhes:

- Aceita polígonos em graus (SIRGAS 2000, WGS 84) ou UTM/Transversa de Mercator em metros (lido do `.prj`). Sem `.prj`, assume graus; se os números não parecem graus, pede o `.prj`. Datum diferente de SIRGAS/WGS 84 vira aviso (pode deslocar dezenas de metros).
- Shapefile com várias feições vira a **união** delas; buracos dentro de uma feição são respeitados.
- Polígonos com mais de 3 000 vértices são simplificados (tolerância a partir de 2 m, informada na tela).
- Para alertas, a distância do foco é medida **até o limite do imóvel** (0 = dentro). Os limites `DIST_ALERTA_KM` e `VENTO_MAX_KM` valem a partir do limite do imóvel, não do centro. A direção "a favor do vento" é medida do ponto do limite mais próximo do foco.
- A folga pode ser alterada com `PATCH /api/areas/:id` (`{ "folga": 8 }`). Para trocar o polígono, cadastre de novo.
- Mensagens e imagem do webhook mostram o imóvel, a faixa de folga e "dentro do imóvel" / "X km do imóvel". O JSON genérico ganhou `tipo_area` (`imovel`/`circulo`) e `folga_km`; as chaves antigas continuam.

## Como o alerta funciona

Para cada área, o sistema calcula a distância de cada foco até o centro e compara com o raio (em área de imóvel: distância até o limite do imóvel, comparada com a folga).

| Nível | Quando |
|---|---|
| Sem focos | Nenhum foco que passe pelo filtro de confiança dentro do raio |
| Atenção | Há foco dentro do raio, mas nenhuma condição de Alerta |
| Alerta | Há foco a `DIST_ALERTA_KM` ou menos (5 km por padrão), ou a favor do vento (diferença de até 45°) a `VENTO_MAX_KM` ou menos (30 km por padrão) |

A Open-Meteo informa a direção **de onde** o vento sopra. A seta no mapa aponta para **onde** ele vai. Um foco "a favor do vento" é avaliado a partir do centro da área; `VENTO_MIN_KMH` (5 por padrão) define a velocidade mínima, e focos com mais de `IDADE_MAX_VENTO_H` (6 h) não ativam Alerta pelo vento. Eles continuam contando para Atenção e para a regra de proximidade. Os limites são pontos de partida, não critérios técnicos validados; ajuste-os com a brigada ou os Bombeiros da região.

Sem focos detectados não significa segurança: os satélites só observam em certos horários.

## Alertas por webhook, com imagem da área

As áreas ficam salvas no servidor (`dados/areas.json`), não só no navegador. Por isso o monitor funciona sozinho, em segundo plano, a cada `MONITOR_MINUTOS` (10 por padrão), mesmo com a página fechada ou o computador tendo reiniciado o processo.

Quando o nível sobe, surge um foco importante ou um foco novo se aproxima, e a área tem um webhook configurado, o servidor:
1. Gera um PNG da área: mapa real de fundo (OpenStreetMap), o círculo do raio, os focos coloridos pela potência, a seta do vento e um resumo em texto.
2. Envia um `POST` com a imagem anexada para a URL do webhook.

**Para configurar:** no formulário "Nova área monitorada", cole a URL no campo "Webhook". Também dá para definir um webhook padrão (usado por áreas sem um webhook próprio) na variável `WEBHOOK_URL` do `.env`. O botão "Testar webhook" de cada área dispara um envio na hora, sem esperar o nível mudar, para você conferir o resultado. O botão "Ver imagem" mostra o PNG sem enviar nada.

A API do painel não retorna a URL do webhook salvo; ela informa apenas se há um webhook configurado. Trate a URL como credencial e regenere-a se ela já foi compartilhada ou exposta.

O monitor registra os focos já avisados para evitar duplicatas, respeita `ENVIO_INTERVALO_MIN` (exceto um foco novo a `DIST_ALERTA_KM` ou menos e uma subida para Alerta) e tenta novamente no próximo ciclo se o envio falhar. Áreas com estado legado, mas sem a lista de focos avisados, recebem uma linha de base silenciosa; áreas sem estado anterior enviam “Primeira leitura da área” quando já há foco e tentam novamente no próximo ciclo se o envio falhar.

Quando o nível fica abaixo do último nível notificado durante `MELHORA_MINUTOS` (60 minutos), o monitor envia um aviso de melhora conforme `AVISAR_MELHORA`: `todos` (padrão), `apos_alerta` ou `nunca`. Se o nível voltar a subir antes desse prazo, a contagem é cancelada. A mensagem de melhora informa se ainda há focos no raio ou se não houve detecções recentes; ausência de detecção não confirma que o fogo terminou.

**Discord:** cole a URL de um webhook de canal (Servidor → Configurações do canal → Integrações → Webhooks). O servidor reconhece o formato pela URL e manda como *embed*, com a imagem dentro da mensagem.

Caso use n8n, Zapier, endpoint seu, etc. o servidor envia um `multipart/form-data` com dois campos:
- `payload`: um JSON em texto com `area`, `nivel` (`ok`/`atencao`/`alto`), `mensagem`, `total_focos`, `confirmados`, `vento` e a lista de `focos` (lat, lon, distância em km, potência, confiança, quantos satélites confirmaram).
- `imagem`: o arquivo PNG.

O JSON também inclui `tipo` (`alerta` ou `melhora`), `motivo`, `emergencia` e, para cada foco, rumo, direção, idade, satélites e se está a favor do vento.

## Variáveis

Copie `.env.example` para `.env`. Não compartilhe o `.env`; URLs de webhook são credenciais.

| Variável | Padrão | Função |
|---|---|---|
| `HOST` | `127.0.0.1` | Endereço de escuta (`0.0.0.0` para aceitar conexões externas; veja o aviso de segurança) |
| `PORT` | 3000 | Porta HTTP |
| `FIRMS_MAP_KEY` | vazio | Chave opcional da NASA FIRMS |
| `WEBHOOK_URL` | vazio | Webhook padrão das áreas sem URL própria |
| `WEBHOOK_NIVEL_MINIMO` | `atencao` | Nível mínimo para envio |
| `CACHE_MINUTOS` | 10 | Cache das consultas |
| `REGIAO_ARQUIVO` | `assets/regiao.geojson` | GeoJSON da região monitorada |
| `FIRMS_TIMEOUT_SEGUNDOS` | 90 | Tempo máximo de cada consulta à FIRMS (inclui o download) |
| `MAX_FOCOS_RESPOSTA` | 30000 | Teto de focos enviados à página (0 = sem teto) |
| `MONITOR_MINUTOS` | 10 | Intervalo de monitoramento |
| `OSM_USER_AGENT` | identificador do projeto | Identificação nas consultas de tiles do OpenStreetMap |
| `DEDUP_KM` | 1.5 | Distância para mesclar focos entre satélites |
| `DIST_ALERTA_KM` | 5 | Foco a esta distância ou menos = Alerta |
| `VENTO_MAX_KM` | 30 | Distância máxima para Alerta por vento |
| `VENTO_MIN_KMH` | 5 | Velocidade mínima do vento considerada |
| `IDADE_MAX_VENTO_H` | 6 | Idade máxima do foco para ativar Alerta pelo vento |
| `CONFIANCA_MINIMA` | `nominal` | Confiança mínima usada pelo monitor (`baixa`, `nominal`, `alta`) |
| `ENVIO_INTERVALO_MIN` | 15 | Intervalo mínimo entre avisos, exceto novo foco próximo |
| `APROX_MARGEM_KM` | 2 | Aproximação mínima de um foco para gerar reaviso |
| `AVISAR_MELHORA` | `todos` | Política de avisos de melhora: `todos`, `apos_alerta` ou `nunca` |
| `MELHORA_MINUTOS` | 60 | Tempo abaixo do nível notificado antes de informar melhora |
| `INPE_GEO` | `off` | `off`, `observar` ou `on` (não ativado automaticamente) |
| `GEO_PODE_ALERTAR` | `false` | Permite que detecção somente geoestacionária cause Alerta |
| `DEDUP_GEO_KM` | 4 | Tolerância espacial para mesclar um foco geoestacionário |
| `GEO_MIN_DETECCOES` | 2 | Varreduras distintas mínimas para incluir foco somente geoestacionário |
| `GEO_JANELA_HORAS` | 3 | Janela de arquivos de 10 minutos consultados |
| `CACHE_GEO_MINUTOS` | 5 | Cache da listagem de arquivos do INPE |

**Sobre o mapa de fundo:** os tiles vêm do OpenStreetMap, de uso gratuito para volumes pessoais como este. Configure `OSM_USER_AGENT` no `.env` com algo que identifique você, como pede a política de uso deles. A atribuição exigida aparece discretamente no rodapé das imagens geradas. O servidor guarda os tiles em cache enquanto o processo roda, então as mesmas áreas não baixam tile de novo a cada ciclo.

## Licença e dados

Código sob licença MIT (`LICENSE`). Os dados vêm de terceiros e seguem os termos de cada fonte: NASA FIRMS (focos), Open-Meteo (vento), OpenStreetMap (tiles das imagens, © contribuidores do OpenStreetMap) e IBGE (limites territoriais). A fonte Roboto está sob SIL Open Font License (`assets/fonts/OFL.txt`).

## Observações

- Os horários dos focos chegam em UTC e são mostrados no horário de Cuiabá, mesmo para focos em fusos diferentes (Acre, Pará).
- O nível de alerta e os detalhes da configuração são disponibilizados em `/api/config`.
- Se você já tinha áreas salvas numa versão anterior (guardadas só no navegador), elas são movidas para o servidor automaticamente na primeira vez que a página abrir.
- Nem todo ponto de calor é incêndio florestal: queimadas controladas e indústrias também aparecem. Use a coluna de potência (FRP) e a confiança como filtro.
