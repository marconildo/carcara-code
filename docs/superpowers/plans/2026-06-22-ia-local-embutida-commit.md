# IA local embutida (v1: motor + sugestão de commit) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar uma IA local opcional ao Carcará Code que, quando ligada, gera mensagens de commit a partir do diff staged — sem depender da sessão do Claude, offline e instantânea.

**Architecture:** Um módulo CJS novo no main process (`llm-core.cjs`, mesmo molde de `mcp-core.cjs`) encapsula o `node-llama-cpp` (carregado *lazy* via `await import()`, pois é ESM-only). Ele expõe `status/download/remove/generate`. O main registra handlers IPC `llm:*` (padrão dos `mcp:*`), o `preload.js` expõe a API, uma aba nova "Recursos de IA" nas Configurações controla ativação/download/toggles, e o `GitPanel` ganha um botão "✨ Gerar" que preenche a textarea de commit. Com a IA desligada ou sem modelo, tudo cai no fluxo atual.

**Tech Stack:** Electron 33, React 19, `node-llama-cpp` v3 (binding nativo CPU, ESM-only), `simple-git` (já existente), Tailwind. Modelo: Qwen2.5 0.5B Instruct Q4_K_M (GGUF).

## Global Constraints

- **Modelo nunca no instalador**: baixa sob demanda para `app.getPath('userData')/models/`. NÃO bundlar o `.gguf`.
- **Nunca carregar no boot**: `node-llama-cpp` só é importado dentro de `llm-core.cjs`, e só na 1ª chamada que precisa dele (`download`/`generate`). Nada de `require`/`import` no topo de `main.js`.
- **Degradação silenciosa**: IA off, modelo ausente, erro ou timeout → comportamento atual; nada bloqueia nem lança pra UI sem `{ ok:false }`.
- **Padrão IPC**: handlers retornam `{ ok:true, ... }` ou `{ ok:false, error }` (igual `mcp:*`/`git:*`). Progresso de download via `safeSend('llm:downloadProgress', ...)` (igual `term:data`).
- **Modelo padrão (constantes fixas no `llm-core.cjs`):**
  - `MODEL_ID = 'qwen2.5-0.5b-instruct-q4_k_m'`
  - `MODEL_FILE = 'Qwen2.5-0.5B-Instruct-Q4_K_M.gguf'`
  - `MODEL_URI = 'hf:bartowski/Qwen2.5-0.5B-Instruct-GGUF/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf'`
- **Geração travada**: `contextSize: 2048`, `temperature: 0.2`, `maxTokens: 48`, timeout 20s.
- **Sem test runner no projeto**: os "testes" são scripts `node` de smoke (padrão da casa, como `mcp-core`) + verificação no app real. Rodar Node fora do Electron exige limpar `ELECTRON_RUN_AS_NODE` (nota do ambiente).

---

### Task 1: Dependência e empacotamento

**Files:**
- Modify: `package.json` (bloco `dependencies` e `build.asarUnpack`)

**Interfaces:**
- Consumes: nada.
- Produces: `node-llama-cpp` disponível para `await import('node-llama-cpp')` em CJS; prebuild nativo desempacotado no portable.

- [ ] **Step 1: Adicionar a dependência**

Run:
```bash
npm install node-llama-cpp@^3
```
Expected: instala sem erro; `node-llama-cpp` aparece em `dependencies` no `package.json`.

- [ ] **Step 2: Desempacotar o binário nativo no build**

Em `package.json`, no array `build.asarUnpack` (hoje só tem `node-pty`), adicionar a linha do `node-llama-cpp`:

```json
    "asarUnpack": [
      "**/node_modules/node-pty/**",
      "**/node_modules/node-llama-cpp/**",
      "**/node_modules/@node-llama-cpp/**"
    ],
```
(`@node-llama-cpp/*` são os pacotes de prebuild por plataforma; precisam sair do asar pra carregar.)

- [ ] **Step 3: Verificar import dinâmico em CJS fora do Electron**

Run:
```bash
node -e "import('node-llama-cpp').then(m => console.log('ok', typeof m.getLlama, typeof m.createModelDownloader)).catch(e => { console.error(e); process.exit(1); })"
```
Expected: imprime `ok function function`. (Se imprimir erro de ABI/native, resolver antes de prosseguir — é o ponto de maior risco.)

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat(ia-local): adiciona node-llama-cpp e desempacota o binário nativo"
```

---

### Task 2: Motor `llm-core.cjs`

**Files:**
- Create: `llm-core.cjs`
- Create: `scripts/llm-smoke.cjs` (smoke manual)

**Interfaces:**
- Consumes: `node-llama-cpp` (`getLlama`, `LlamaChatSession`, `createModelDownloader`) via `await import()`.
- Produces (consumido pela Task 3):
  - `MODEL_ID: string`, `MODEL_FILE: string`
  - `modelPath(userDataDir: string): string`
  - `status(userDataDir): Promise<{ installed: boolean, path: string, sizeBytes: number }>`
  - `download(userDataDir, onProgress: ({done,total})=>void): Promise<{ path: string }>`
  - `remove(userDataDir): Promise<void>`
  - `generate({ userDataDir, task: 'commit', input: string }): Promise<string>` — devolve texto curto; lança em erro/timeout/modelo ausente.

- [ ] **Step 1: Escrever o módulo**

Create `llm-core.cjs`:

```js
// Motor de IA local — sem dependência de Electron, testável por smoke via Node.
// node-llama-cpp v3 é ESM-only, então carregamos via import() dinâmico (lazy de fato:
// o binário nativo só entra na 1ª chamada que precisa dele).
const fs = require('fs');
const path = require('path');

const MODEL_ID = 'qwen2.5-0.5b-instruct-q4_k_m';
const MODEL_FILE = 'Qwen2.5-0.5B-Instruct-Q4_K_M.gguf';
const MODEL_URI = 'hf:bartowski/Qwen2.5-0.5B-Instruct-GGUF/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf';

const GEN = { contextSize: 2048, temperature: 0.2, maxTokens: 48, timeoutMs: 20000 };

// Prompt de sistema fixo por tarefa. Travado: saída curta, sem explicação.
const SYSTEM = {
  commit:
    'Você gera mensagens de commit curtas em português, no estilo Conventional Commits ' +
    '(formato "tipo: descrição", ex.: "fix: corrige validação do login"). ' +
    'Máximo ~8 palavras. Responda APENAS a mensagem, sem aspas e sem explicação.',
};

let _libPromise; // cache do import() ESM
function lib() { return (_libPromise = _libPromise || import('node-llama-cpp')); }

let _llama, _model, _modelPathLoaded; // modelo fica quente após a 1ª geração

function modelsDir(userDataDir) { return path.join(userDataDir, 'models'); }
function modelPath(userDataDir) { return path.join(modelsDir(userDataDir), MODEL_FILE); }

async function status(userDataDir) {
  const p = modelPath(userDataDir);
  try {
    const st = fs.statSync(p);
    return { installed: true, path: p, sizeBytes: st.size };
  } catch {
    return { installed: false, path: p, sizeBytes: 0 };
  }
}

async function download(userDataDir, onProgress) {
  const { createModelDownloader } = await lib();
  fs.mkdirSync(modelsDir(userDataDir), { recursive: true });
  const downloader = await createModelDownloader({
    modelUri: MODEL_URI,
    dirPath: modelsDir(userDataDir),
    onProgress: ({ totalSize, downloadedSize }) => {
      if (typeof onProgress === 'function') onProgress({ done: downloadedSize || 0, total: totalSize || 0 });
    },
  });
  const outPath = await downloader.download();
  return { path: outPath };
}

async function remove(userDataDir) {
  // Descarrega o que estiver quente antes de apagar o arquivo.
  try { if (_model) await _model.dispose(); } catch {}
  _model = null; _modelPathLoaded = null;
  try { fs.unlinkSync(modelPath(userDataDir)); } catch {}
}

async function ensureModel(userDataDir) {
  const p = modelPath(userDataDir);
  if (!fs.existsSync(p)) throw new Error('Modelo não baixado.');
  const { getLlama } = await lib();
  if (!_llama) _llama = await getLlama();
  if (!_model || _modelPathLoaded !== p) {
    if (_model) { try { await _model.dispose(); } catch {} }
    _model = await _llama.loadModel({ modelPath: p });
    _modelPathLoaded = p;
  }
  return _model;
}

async function generate({ userDataDir, task, input }) {
  const sys = SYSTEM[task];
  if (!sys) throw new Error('Tarefa de IA desconhecida: ' + task);
  const model = await ensureModel(userDataDir);
  const { LlamaChatSession } = await lib();
  // Contexto fresco por chamada (sem histórico entre gerações); descartado no fim.
  const context = await model.createContext({ contextSize: GEN.contextSize });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), GEN.timeoutMs);
  try {
    const session = new LlamaChatSession({ contextSequence: context.getSequence(), systemPrompt: sys });
    const out = await session.prompt(String(input || ''), {
      temperature: GEN.temperature,
      maxTokens: GEN.maxTokens,
      signal: ac.signal,
    });
    return String(out || '').trim().replace(/^["'`]|["'`]$/g, '').split('\n')[0].trim();
  } finally {
    clearTimeout(timer);
    try { await context.dispose(); } catch {}
  }
}

module.exports = { MODEL_ID, MODEL_FILE, MODEL_URI, modelPath, status, download, remove, generate };
```

- [ ] **Step 2: Escrever o smoke script**

Create `scripts/llm-smoke.cjs`:

```js
// Smoke do motor de IA local, fora do Electron.
// Uso: node scripts/llm-smoke.cjs [diretorio-userData]
// (limpe ELECTRON_RUN_AS_NODE antes, se estiver setado no ambiente)
const os = require('os');
const path = require('path');
const llm = require('../llm-core.cjs');

const userDataDir = process.argv[2] || path.join(os.homedir(), '.carcara-code-smoke');

(async () => {
  const st = await llm.status(userDataDir);
  console.log('status:', st);
  if (!st.installed) {
    console.log('Modelo ausente. Rode o download pelo app (aba Recursos de IA) ou:');
    console.log('  node -e "require(\'./llm-core.cjs\').download(' + JSON.stringify(userDataDir) +
      ', p => process.stdout.write((p.total? Math.round(100*p.done/p.total):0)+\'%\\r\')).then(()=>console.log(\'\\nok\'))"');
    return;
  }
  const diff = process.argv[3] ||
    'diff --git a/login.js b/login.js\n+ if (!password) return error("senha obrigatória");';
  const msg = await llm.generate({ userDataDir, task: 'commit', input: diff });
  console.log('commit sugerido:', JSON.stringify(msg));
})().catch((e) => { console.error('FALHOU:', e); process.exit(1); });
```

- [ ] **Step 3: Rodar o smoke sem modelo (caminho de degradação)**

Run:
```bash
node scripts/llm-smoke.cjs
```
Expected: imprime `status: { installed: false, ... }` e a instrução de download — **sem** crashar e **sem** carregar binário nativo.

- [ ] **Step 4: Baixar o modelo uma vez e gerar (verificação manual, ~400MB)**

Run:
```bash
node -e "require('./llm-core.cjs').download(require('path').join(require('os').homedir(),'.carcara-code-smoke'), p => process.stdout.write((p.total?Math.round(100*p.done/p.total):0)+'%\r')).then(()=>console.log('\nbaixado'))"
node scripts/llm-smoke.cjs
```
Expected: progresso vai a 100%, depois `commit sugerido: "..."` — uma linha curta, estilo `tipo: descrição`, em <~2s após o modelo carregar.

- [ ] **Step 5: Commit**

```bash
git add llm-core.cjs scripts/llm-smoke.cjs
git commit -m "feat(ia-local): motor llm-core (status/download/remove/generate) + smoke"
```

---

### Task 3: Handlers IPC no main process

**Files:**
- Modify: `main.js` (require do `llm-core` no topo — só o módulo JS, sem tocar no nativo; bloco de handlers `llm:*` junto dos demais; helper de config `llm`)

**Interfaces:**
- Consumes: `llm-core.cjs` (Task 2); `loadConfig/saveConfig` (`main.js:36-54`); `safeSend` (`main.js:66`); `app.getPath('userData')`.
- Produces (consumido por preload/UI): handlers `llm:status`, `llm:download`, `llm:remove`, `llm:generate`, `llm:getConfig`, `llm:setConfig`; evento `llm:downloadProgress`.

- [ ] **Step 1: Require do módulo (seguro — não toca no nativo)**

Perto do topo de `main.js`, ao lado de `const mcpCore = require('./mcp-core.cjs');` (linha 9):

```js
const llmCore = require('./llm-core.cjs');
```
(O `node-llama-cpp` só é carregado dentro de `llm-core` via `import()`, então este `require` não pesa no boot.)

- [ ] **Step 2: Helper de config `llm` com defaults**

Adicionar perto dos outros helpers de config (depois de `saveConfig`, ~linha 54):

```js
function llmConfig() {
  const c = loadConfig();
  const llm = c.llm || {};
  return {
    enabled: !!llm.enabled,
    model: llm.model || llmCore.MODEL_ID,
    features: { commit: !!(llm.features && llm.features.commit) },
  };
}
```

- [ ] **Step 3: Bloco de handlers IPC**

Adicionar um bloco novo junto dos handlers MCP (ex.: logo antes de `// ---------- Preview (dev server) ----------`, ~linha 1324):

```js
// ---------- IA local (llm-core) ----------
// Modelo/binário nativo carregam lazy dentro do llm-core; nada disso no boot.
const llmUserDir = () => app.getPath('userData');

ipcMain.handle('llm:getConfig', () => ({ ok: true, ...llmConfig() }));
ipcMain.handle('llm:setConfig', (evt, { patch }) => {
  const c = loadConfig();
  const cur = llmConfig();
  c.llm = {
    enabled: patch.enabled ?? cur.enabled,
    model: cur.model,
    features: { ...cur.features, ...(patch.features || {}) },
  };
  saveConfig(c);
  return { ok: true, ...c.llm };
});

ipcMain.handle('llm:status', async () => {
  try { return { ok: true, ...(await llmCore.status(llmUserDir())) }; }
  catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
});

ipcMain.handle('llm:download', async () => {
  try {
    await llmCore.download(llmUserDir(), ({ done, total }) =>
      safeSend('llm:downloadProgress', { done, total }));
    return { ok: true, ...(await llmCore.status(llmUserDir())) };
  } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
});

ipcMain.handle('llm:remove', async () => {
  try { await llmCore.remove(llmUserDir()); return { ok: true }; }
  catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
});

ipcMain.handle('llm:generate', async (evt, { task, input }) => {
  try { return { ok: true, text: await llmCore.generate({ userDataDir: llmUserDir(), task, input }) }; }
  catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
});
```

- [ ] **Step 4: Verificar que o boot segue intacto**

Run:
```bash
npm run build
npm start
```
Expected: app abre normalmente, splash no mesmo tempo de antes; nenhum erro no console do main sobre `node-llama-cpp`. (Confirma que o `require('./llm-core.cjs')` não carregou o nativo.)

- [ ] **Step 5: Commit**

```bash
git add main.js
git commit -m "feat(ia-local): handlers IPC llm:* e config llm no main"
```

---

### Task 4: Expor a API no preload

**Files:**
- Modify: `preload.js` (novo bloco no objeto exposto)

**Interfaces:**
- Consumes: handlers `llm:*` (Task 3).
- Produces (consumido pela UI): `window.api.llmGetConfig()`, `llmSetConfig(patch)`, `llmStatus()`, `llmDownload()`, `llmRemove()`, `llmGenerate(task, input)`, e `onLlmDownloadProgress(cb)`.

- [ ] **Step 1: Adicionar o bloco**

No `preload.js`, dentro do objeto passado a `exposeInMainWorld('api', { ... })` — por exemplo logo após o bloco "MCP connector" (linha 93):

```js
  // IA local (llm-core): config, modelo e geração de texto curto
  llmGetConfig: () => ipcRenderer.invoke('llm:getConfig'),
  llmSetConfig: (patch) => ipcRenderer.invoke('llm:setConfig', { patch }),
  llmStatus: () => ipcRenderer.invoke('llm:status'),
  llmDownload: () => ipcRenderer.invoke('llm:download'),
  llmRemove: () => ipcRenderer.invoke('llm:remove'),
  llmGenerate: (task, input) => ipcRenderer.invoke('llm:generate', { task, input }),
  onLlmDownloadProgress: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('llm:downloadProgress', handler);
    return () => ipcRenderer.removeListener('llm:downloadProgress', handler);
  },
```

- [ ] **Step 2: Verificar a ponte**

Run: `npm run build && npm start`. No DevTools do renderer (Ctrl+Shift+I), no console:
```js
await window.api.llmGetConfig()
await window.api.llmStatus()
```
Expected: o 1º devolve `{ ok:true, enabled:false, model:'qwen2.5-0.5b-instruct-q4_k_m', features:{commit:false} }`; o 2º `{ ok:true, installed:<bool>, ... }`.

- [ ] **Step 3: Commit**

```bash
git add preload.js
git commit -m "feat(ia-local): expõe API llm no preload"
```

---

### Task 5: Aba "Recursos de IA" nas Configurações

**Files:**
- Modify: `src/components/SettingsModal.jsx` (novo `TabButton`, novo cabeçalho, novo painel `tab === 'llm'`)

**Interfaces:**
- Consumes: `window.api.llmGetConfig/llmSetConfig/llmStatus/llmDownload/llmRemove/onLlmDownloadProgress` (Task 4); `Switch` de `./ui/switch.jsx`.
- Produces: persiste `llm.enabled` e `llm.features.commit`; permite baixar/remover o modelo. (O `GitPanel` lê esse mesmo config na Task 6.)

- [ ] **Step 1: Importar um ícone pra aba**

No import de `lucide-react` (linha 2), acrescentar `Sparkles` e `Download` e `Trash2`:

```js
import { Sun, Moon, X, Check, Paintbrush, Bot, Wrench, Monitor, Terminal, ZoomIn, ZoomOut, RotateCcw, Bell, Sparkles, Download, Trash2 } from 'lucide-react';
```

- [ ] **Step 2: Estado e carregamento do painel de IA**

Dentro de `SettingsModal`, junto dos outros `useState` (após linha 41):

```js
  const [llmCfg, setLlmCfg] = useState({ enabled: false, features: { commit: false } });
  const [llmStat, setLlmStat] = useState({ installed: false, sizeBytes: 0 });
  const [dl, setDl] = useState(null); // { done, total } enquanto baixa; null fora disso
```

E um `useEffect` que carrega ao abrir e escuta o progresso (após o `useEffect` da linha 60-68):

```js
  useEffect(() => {
    if (!open) return;
    window.api.llmGetConfig().then((r) => { if (r?.ok) setLlmCfg(r); }).catch(() => {});
    window.api.llmStatus().then((r) => { if (r?.ok) setLlmStat(r); }).catch(() => {});
    const off = window.api.onLlmDownloadProgress((p) => setDl(p));
    return off;
  }, [open]);
```

E os handlers de ação (perto de `toggleNotify`, ~linha 50):

```js
  const setLlmEnabled = (v) => {
    setLlmCfg((c) => ({ ...c, enabled: v }));
    window.api.llmSetConfig({ enabled: v });
  };
  const setCommitFeature = (v) => {
    setLlmCfg((c) => ({ ...c, features: { ...c.features, commit: v } }));
    window.api.llmSetConfig({ features: { commit: v } });
  };
  const doDownload = async () => {
    setDl({ done: 0, total: 0 });
    const r = await window.api.llmDownload();
    setDl(null);
    if (r?.ok) setLlmStat(r);
  };
  const doRemove = async () => {
    await window.api.llmRemove();
    const r = await window.api.llmStatus();
    if (r?.ok) setLlmStat(r);
  };
```

- [ ] **Step 3: Botão da aba e título**

Na navegação lateral, após a linha 102 (`Notificações`):

```jsx
        <TabButton active={tab === 'llm'} onClick={() => setTab('llm')} icon={<Sparkles />}>Recursos de IA</TabButton>
```

No `<h1>` do cabeçalho (linha 108-110), incluir o título da aba:

```jsx
            {tab === 'ai' ? 'IA por projeto' : tab === 'notify' ? 'Notificações' : tab === 'llm' ? 'Recursos de IA' : 'Aparência'}
```

- [ ] **Step 4: Painel da aba**

Após o bloco `{tab === 'notify' && ( ... )}` (fecha na linha 262), adicionar:

```jsx
          {tab === 'llm' && (
            <div className="mx-auto max-w-3xl">
              <p className="text-sm text-muted-foreground">
                Uma IA local minúscula, offline, pra tarefas curtas (ex.: sugerir mensagem de commit).
                É opcional: ative, baixe o modelo uma vez (~400&nbsp;MB) e ligue só o que quiser.
                Desligada, o app funciona normalmente.
              </p>

              {/* Master */}
              <div className="mt-5 flex items-start justify-between gap-4 rounded-lg border p-4">
                <div className="min-w-0">
                  <div className="text-[13px] font-medium">Ativar IA local</div>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    Roda direto no seu computador, sem internet e sem usar sua sessão do Claude.
                  </p>
                </div>
                <Switch checked={llmCfg.enabled} onCheckedChange={setLlmEnabled} className="mt-0.5" />
              </div>

              {/* Modelo */}
              {llmCfg.enabled && (
                <div className="mt-3 rounded-lg border p-4">
                  <div className="flex items-center justify-between gap-4">
                    <div className="text-[13px] font-medium">
                      Modelo local
                      <span className="ml-2 text-xs font-normal text-muted-foreground">
                        {dl ? 'baixando…' : llmStat.installed ? 'pronto' : 'não baixado'}
                      </span>
                    </div>
                    {!dl && (llmStat.installed
                      ? <button type="button" onClick={doRemove}
                          className="flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-muted [&_svg]:size-3.5">
                          <Trash2 /> Remover
                        </button>
                      : <button type="button" onClick={doDownload}
                          className="flex items-center gap-1.5 rounded-md border border-primary px-2.5 py-1.5 text-[13px] text-primary transition-colors hover:bg-muted [&_svg]:size-3.5">
                          <Download /> Baixar (~400 MB)
                        </button>)}
                  </div>
                  {dl && (
                    <div className="mt-3">
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                        <div className="h-full bg-primary transition-all"
                          style={{ width: (dl.total ? Math.round((100 * dl.done) / dl.total) : 0) + '%' }} />
                      </div>
                      <div className="mt-1 text-xs tabular-nums text-muted-foreground">
                        {dl.total ? Math.round((100 * dl.done) / dl.total) : 0}%
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Recursos por toggle */}
              {llmCfg.enabled && (
                <div className="mt-3 rounded-lg border p-4">
                  <div className="text-[13px] font-medium">Recursos</div>
                  <div className="mt-3 flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="text-[13px]">Botão de sugestão de mensagem de commit</div>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                        Mostra um botão “✨ Gerar” na aba Git que escreve a mensagem a partir do que está em stage.
                      </p>
                    </div>
                    <Switch checked={llmCfg.features.commit} onCheckedChange={setCommitFeature}
                      disabled={!llmStat.installed} className="mt-0.5" />
                  </div>
                  <p className="mt-3 text-xs text-muted-foreground">Títulos de histórico e de prompt: em breve.</p>
                </div>
              )}
            </div>
          )}
```

- [ ] **Step 5: Verificar no app**

Run: `npm run build && npm start`. Abrir Configurações → "Recursos de IA". Ligar o master; clicar Baixar; ver a barra ir a 100% e virar "pronto"; ligar o toggle de commit. Reabrir o modal: estado persiste.
Expected: download conclui, toggles persistem, nada quebra com o master desligado.

- [ ] **Step 6: Commit**

```bash
git add src/components/SettingsModal.jsx
git commit -m "feat(ia-local): aba Recursos de IA (ativar, baixar/remover modelo, toggle de commit)"
```

---

### Task 6: Botão "✨ Gerar" no GitPanel

**Files:**
- Modify: `src/components/GitPanel.jsx` (estado da config de IA + botão acima/junto da textarea de commit)

**Interfaces:**
- Consumes: `window.api.llmGetConfig()`, `window.api.llmStatus()`, `window.api.gitDiff()` (existente), `window.api.llmGenerate('commit', diff)`; `toast` (já importado, linha 21).
- Produces: preenche `message` (estado existente, linha 81). Nenhum novo consumidor.

- [ ] **Step 1: Importar o ícone**

No import de `lucide-react` (linhas 2-5), adicionar `Sparkles`:

```js
import {
  GitBranch, ArrowUp, ArrowDown, Plus, Minus, Check,
  AlertTriangle, Copy, X, Sparkles,
} from 'lucide-react';
```

- [ ] **Step 2: Estado da IA e carregamento**

Junto dos `useState` do componente (após linha 86):

```js
  const [llm, setLlm] = useState({ enabled: false, ready: false, commit: false });
  const [genBusy, setGenBusy] = useState(false);
```

E um efeito que recarrega quando a aba fica visível (após o efeito da linha 97):

```js
  // Config da IA local: o botão "✨ Gerar" só aparece se ligada + modelo pronto + recurso ativo.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    (async () => {
      const [cfg, st] = await Promise.all([window.api.llmGetConfig(), window.api.llmStatus()]);
      if (cancelled) return;
      setLlm({
        enabled: !!cfg?.enabled,
        commit: !!cfg?.features?.commit,
        ready: !!st?.installed,
      });
    })();
    return () => { cancelled = true; };
  }, [visible]);
```

- [ ] **Step 3: Função de geração**

Colocar **depois** das declarações de `staged`/`changes`/`hasChanges` (logo após `canCommit`, ~linha 169) pra ficar no mesmo escopo e legível — `generateCommit` usa essas variáveis:

```js
  const generateCommit = async () => {
    const list = staged.length > 0 ? staged : changes;
    if (list.length === 0) return;
    setGenBusy(true);
    try {
      // Junta os diffs dos arquivos relevantes (truncado pra caber no contexto do modelo).
      const parts = [];
      for (const f of list.slice(0, 20)) {
        const r = await window.api.gitDiff(projectPath, f.path, isStaged(f), f.index === '?' && f.working === '?');
        if (r?.ok && r.diff) parts.push(r.diff);
      }
      const diff = parts.join('\n').slice(0, 6000);
      const res = await window.api.llmGenerate('commit', diff || list.map((f) => f.path).join('\n'));
      if (res?.ok && res.text) setMessage(res.text);
      else toast.error('Não consegui gerar agora.');
    } catch {
      toast.error('Não consegui gerar agora.');
    } finally {
      setGenBusy(false);
    }
  };
```

- [ ] **Step 4: Botão na área de commit**

Logo após o `</textarea>` (linha 242), antes do botão de Commit (linha 243):

```jsx
        {llm.enabled && llm.commit && llm.ready && (
          <Button size="sm" variant="ghost" className="mt-1.5 w-full gap-1.5 text-muted-foreground"
            disabled={genBusy || !hasChanges}
            onClick={generateCommit}>
            <Sparkles className={'size-4 ' + (genBusy ? 'animate-pulse' : '')} />
            {genBusy ? 'Gerando…' : 'Gerar mensagem'}
          </Button>
        )}
```

- [ ] **Step 5: Verificação end-to-end**

Run: `npm run build && npm start`. Com a IA ligada + modelo pronto + recurso de commit ativo:
1. Abrir um projeto git, fazer/editar arquivos, dar stage.
2. Na aba Git, clicar "✨ Gerar mensagem".
Expected: a textarea é preenchida com uma mensagem curta estilo `tipo: descrição` em <~2s; dá pra editar e commitar normal. Desligando o master nas Configurações e voltando à aba Git, o botão some e o commit manual segue igual.

- [ ] **Step 6: Commit**

```bash
git add src/components/GitPanel.jsx
git commit -m "feat(ia-local): botão Gerar mensagem de commit no GitPanel"
```

---

## Notas de verificação global (spec §Verificação)

1. **Boot intacto** — Task 3 Step 4 e cada `npm start` confirmam que o nativo não carrega no boot.
2. **Smoke do motor** — Task 2 Steps 3-4.
3. **Download** — Task 5 Step 5.
4. **Commit assist** — Task 6 Step 5.
5. **Degradação** — Task 6 Step 5 (desligar master) + Task 2 Step 3 (sem modelo).

## Riscos

- **Maior risco: o binário nativo do `node-llama-cpp` no portable Windows.** Validar cedo (Task 1 Step 3) e, ao empacotar (`npm run pack:exe`), abrir o `.exe` e baixar/gerar de fato. Se o prebuild não carregar empacotado, revisar `asarUnpack` (incluir `@node-llama-cpp/*`).
- **`modelUri` do HuggingFace** pode mudar de repo/arquivo; as constantes ficam centralizadas no topo do `llm-core.cjs`.
- **Primeira geração** carrega ~400MB na RAM (fica quente). Em PC muito fraco, a 1ª resposta demora mais; o timeout de 20s cobre o pior caso sem travar a UI.
