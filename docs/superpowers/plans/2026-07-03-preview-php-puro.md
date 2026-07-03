# Preview PHP puro — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rodar sites/arquivos PHP puros no Preview do Carcará, baixando o runtime PHP sob demanda, sem tocar no fluxo Node existente.

**Architecture:** Toda a lógica PHP vive num módulo isolado `php-runtime.cjs` (Node puro, sem `require` de Electron, testável por smoke — igual ao `mcp-core.cjs`). O `main.js` só ganha um ramo `if (type === 'php')` no `preview:start` que delega ao módulo e **reusa** o motor de preview atual (porta livre, probe HTTP, `runningServers`, `preview:ready/exit`). A UI é aditiva: `projects:list` passa a devolver `previewType`, e a UI deriva `canPreview` sem remover o campo `hasPkg` existente.

**Tech Stack:** Electron (main process CJS), Node `https`/`crypto`/`child_process`, PowerShell `Expand-Archive` (Windows) para descompactar, React (renderer), Vitest não se aplica aqui (o padrão do projeto para o main é smoke `.cjs`).

## Global Constraints

- **Plataforma-alvo: Windows apenas.** O download do PHP e o `Expand-Archive` assumem Windows. Nada de macOS/Linux neste plano.
- **Node intocado.** Nenhuma mudança pode alterar o comportamento, o nome de campo (`hasPkg`) ou o caminho de código do ramo Node. Mudanças na UI são aditivas.
- **Módulo isolado.** `php-runtime.cjs` NÃO pode `require('electron')` nem depender de janela — recebe dependências (ex.: diretório de cache) por parâmetro, para rodar sob `node scripts/php-smoke.cjs`.
- **Runtime PHP fixado:** versão `8.5.8`, arquivo `php-8.5.8-nts-Win32-vs17-x64.zip`, com **sha256 fixado no código** (constante `PHP_SHA256`, obtida do `sha256sum.txt` oficial — ver Task 2). Binário não verificado nunca é executado.
- **Sem novas dependências npm.** Descompactação via `Expand-Archive` (PowerShell embutido no Windows), download via `https` nativo.
- **Convenção de commit:** mensagens em pt-BR, prefixo `feat:`/`test:`/`docs:`, terminando com a linha `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## File Structure

- **Create `php-runtime.cjs`** (raiz, irmão de `mcp-core.cjs`) — todas as funções PHP: `detectProjectType`, `resolvePhpDocroot`, `buildPhpServeArgs`, `isVcRedistError`, `verifySha256`, `ensurePhpRuntime` + constantes de versão/URL/hash.
- **Create `scripts/php-smoke.cjs`** — smoke test das funções puras do módulo (padrão dos `.cjs` existentes).
- **Modify `package.json`** — adicionar script `"test:php": "node scripts/php-smoke.cjs"`.
- **Modify `main.js`** — (a) `require('./php-runtime.cjs')`; (b) ramo `php` no `ipcMain.handle('preview:start')` (~2240); (c) `previewType` no `projects:list` (~629).
- **Modify `src/App.jsx`** — gate `active?.hasPkg` (~456) passa a usar `canPreview`.
- **Modify `src/components/PreviewPanel.jsx`** — gates `active.hasPkg` (~723 e ~1062) passam a usar `canPreview`.

---

## Task 1: Módulo `php-runtime.cjs` — funções puras + smoke

**Files:**
- Create: `php-runtime.cjs`
- Create: `scripts/php-smoke.cjs`
- Modify: `package.json` (scripts)

**Interfaces:**
- Produces:
  - `detectProjectType(projectPath: string) -> 'node' | 'php' | null`
  - `resolvePhpDocroot(projectPath: string) -> string` (caminho absoluto do docroot)
  - `buildPhpServeArgs({ port: number, docroot: string }) -> string[]` (args após `php.exe`)
  - `isVcRedistError({ log: string, elapsedMs: number }) -> boolean`
  - `verifySha256(filePath: string, expectedHex: string) -> Promise<boolean>`

- [ ] **Step 1: Escrever o smoke test que falha**

Create `scripts/php-smoke.cjs`:

```javascript
// Smoke das funções puras do php-runtime, fora do Electron.
// Uso: node scripts/php-smoke.cjs
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {
  detectProjectType, resolvePhpDocroot, buildPhpServeArgs,
  isVcRedistError, verifySha256,
} = require('../php-runtime.cjs');

function assert(cond, msg) { if (!cond) throw new Error('ASSERT: ' + msg); }
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'carcara-php-')); }
function write(dir, rel, content) {
  const f = path.join(dir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
  return f;
}

async function run() {
  // detectProjectType
  const nodeDir = tmp();
  write(nodeDir, 'package.json', JSON.stringify({ scripts: { dev: 'vite' } }));
  assert(detectProjectType(nodeDir) === 'node', 'package.json com dev -> node');

  const phpDir = tmp();
  write(phpDir, 'index.php', '<?php echo "oi";');
  assert(detectProjectType(phpDir) === 'php', 'index.php solto -> php');

  const bothDir = tmp();
  write(bothDir, 'package.json', JSON.stringify({ scripts: { dev: 'vite' } }));
  write(bothDir, 'index.php', '<?php');
  assert(detectProjectType(bothDir) === 'node', 'node vence quando há package.json com script');

  const pkgNoScript = tmp();
  write(pkgNoScript, 'package.json', JSON.stringify({ scripts: { build: 'x' } }));
  write(pkgNoScript, 'app.php', '<?php');
  assert(detectProjectType(pkgNoScript) === 'php', 'package.json sem dev/start/serve mas com .php -> php');

  const emptyDir = tmp();
  assert(detectProjectType(emptyDir) === null, 'pasta vazia -> null');
  console.log('detectProjectType ok');

  // resolvePhpDocroot
  const rootDoc = tmp();
  write(rootDoc, 'index.php', '<?php');
  assert(resolvePhpDocroot(rootDoc) === rootDoc, 'sem public/ -> raiz');

  const pubDoc = tmp();
  write(pubDoc, 'public/index.php', '<?php');
  assert(resolvePhpDocroot(pubDoc) === path.join(pubDoc, 'public'), 'com public/index.php -> public/');
  console.log('resolvePhpDocroot ok');

  // buildPhpServeArgs
  const args = buildPhpServeArgs({ port: 8123, docroot: 'C:\\proj\\public' });
  assert(JSON.stringify(args) === JSON.stringify(['-S', '127.0.0.1:8123', '-t', 'C:\\proj\\public']),
    'args do php -S corretos: ' + JSON.stringify(args));
  console.log('buildPhpServeArgs ok');

  // isVcRedistError
  assert(isVcRedistError({ log: 'The code execution cannot proceed VCRUNTIME140.dll was not found', elapsedMs: 200 }) === true,
    'stderr com VCRUNTIME140.dll e saída rápida -> true');
  assert(isVcRedistError({ log: 'PHP 8.5.8 Development Server started', elapsedMs: 200 }) === false,
    'log normal -> false');
  assert(isVcRedistError({ log: 'VCRUNTIME140.dll', elapsedMs: 9000 }) === false,
    'saída tardia não é erro de VC redist');
  console.log('isVcRedistError ok');

  // verifySha256
  const hashDir = tmp();
  const buf = Buffer.from('carcara-php-smoke-fixture');
  const f = write(hashDir, 'blob.bin', buf);
  const expected = crypto.createHash('sha256').update(buf).digest('hex');
  assert((await verifySha256(f, expected)) === true, 'sha256 correto -> true');
  assert((await verifySha256(f, expected.toUpperCase())) === true, 'sha256 case-insensitive -> true');
  assert((await verifySha256(f, '00'.repeat(32))) === false, 'sha256 errado -> false');
  console.log('verifySha256 ok');

  console.log('\nphp-smoke OK');
}
run().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
```

- [ ] **Step 2: Rodar o smoke e ver falhar**

Run: `node scripts/php-smoke.cjs`
Expected: FAIL com `Cannot find module '../php-runtime.cjs'`

- [ ] **Step 3: Implementar `php-runtime.cjs` (funções puras)**

Create `php-runtime.cjs`:

```javascript
// Runtime PHP isolado do main.js. Node puro (sem require de electron),
// pra ser testável por scripts/php-smoke.cjs.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// --- Detecção de tipo de projeto ---------------------------------------
function hasNodeDevScript(projectPath) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectPath, 'package.json'), 'utf8'));
    const s = pkg.scripts || {};
    return Boolean(s.dev || s.start || s.serve);
  } catch { return false; }
}

function hasAnyPhpFile(projectPath) {
  // index.php na raiz ou em public/ é o caso comum; senão qualquer .php no topo.
  if (fs.existsSync(path.join(projectPath, 'index.php'))) return true;
  if (fs.existsSync(path.join(projectPath, 'public', 'index.php'))) return true;
  try {
    return fs.readdirSync(projectPath).some((f) => f.toLowerCase().endsWith('.php'));
  } catch { return false; }
}

function detectProjectType(projectPath) {
  if (hasNodeDevScript(projectPath)) return 'node'; // Node vence sempre
  if (hasAnyPhpFile(projectPath)) return 'php';
  return null;
}

function resolvePhpDocroot(projectPath) {
  if (fs.existsSync(path.join(projectPath, 'public', 'index.php'))) {
    return path.join(projectPath, 'public');
  }
  return projectPath;
}

function buildPhpServeArgs({ port, docroot }) {
  return ['-S', `127.0.0.1:${port}`, '-t', docroot];
}

// --- Classificador de erro de VC redist --------------------------------
function isVcRedistError({ log, elapsedMs }) {
  const quick = elapsedMs < 4000;                 // saiu quase na hora
  const dll = /VCRUNTIME140|MSVCP140|vcruntime140/i.test(log || '');
  return quick && dll;
}

// --- Verificação de sha256 ---------------------------------------------
function verifySha256(filePath, expectedHex) {
  return new Promise((resolve) => {
    const hash = crypto.createHash('sha256');
    const s = fs.createReadStream(filePath);
    s.on('error', () => resolve(false));
    s.on('data', (d) => hash.update(d));
    s.on('end', () => resolve(hash.digest('hex').toLowerCase() === String(expectedHex).toLowerCase()));
  });
}

module.exports = {
  detectProjectType, resolvePhpDocroot, buildPhpServeArgs,
  isVcRedistError, verifySha256,
};
```

- [ ] **Step 4: Rodar o smoke e ver passar**

Run: `node scripts/php-smoke.cjs`
Expected: PASS — imprime `detectProjectType ok`, `resolvePhpDocroot ok`, `buildPhpServeArgs ok`, `isVcRedistError ok`, `verifySha256 ok`, `php-smoke OK`

- [ ] **Step 5: Adicionar o script de teste ao `package.json`**

Em `package.json`, dentro de `"scripts"`, após a linha `"test:csv": "node scripts/csv-smoke.cjs"`, adicionar:

```json
    "test:php": "node scripts/php-smoke.cjs"
```

(Lembrar da vírgula na linha anterior.)

- [ ] **Step 6: Rodar via npm**

Run: `npm run test:php`
Expected: PASS — mesma saída do Step 4.

- [ ] **Step 7: Commit**

```bash
git add php-runtime.cjs scripts/php-smoke.cjs package.json
git commit -m "feat: php-runtime.cjs com detecção de tipo, docroot e helpers puros

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Aquisição do runtime PHP sob demanda (`ensurePhpRuntime`)

**Files:**
- Modify: `php-runtime.cjs` (adicionar constantes + `ensurePhpRuntime` + download/extract)
- Modify: `scripts/php-smoke.cjs` (asserts sobre as constantes fixadas)

**Interfaces:**
- Consumes: `verifySha256` (Task 1).
- Produces:
  - Constantes: `PHP_VERSION: string`, `PHP_ZIP_NAME: string`, `PHP_DOWNLOAD_URLS: string[]`, `PHP_SHA256: string`.
  - `ensurePhpRuntime({ cacheBaseDir: string, onPhase?: (msg: string) => void }) -> Promise<string>` — retorna o caminho absoluto do `php.exe` (baixando/extraindo na 1ª vez; reusando o cache depois). Lança `Error` com mensagem clara em falha de rede/hash/extração.

- [ ] **Step 1: Obter e fixar o sha256 oficial**

Rodar (PowerShell) para baixar a lista oficial de checksums e extrair a linha do nosso zip:

```powershell
$u = "https://windows.php.net/downloads/releases/sha256sum.txt"
(Invoke-WebRequest -UseBasicParsing $u).Content -split "`n" | Select-String "php-8.5.8-nts-Win32-vs17-x64.zip"
```

Expected: uma linha no formato `<64-hex>  php-8.5.8-nts-Win32-vs17-x64.zip`.
Copiar o valor de 64 hex — será a constante `PHP_SHA256` no próximo step.

Se a 8.5.8 já tiver saído de `/releases/` (movida pra `/releases/archives/`), usar:
`https://windows.php.net/downloads/releases/archives/sha256sum.txt`.

- [ ] **Step 2: Escrever asserts das constantes no smoke (falham antes de existirem)**

Em `scripts/php-smoke.cjs`, adicionar ao topo do `require` do módulo os nomes novos:

```javascript
const {
  detectProjectType, resolvePhpDocroot, buildPhpServeArgs,
  isVcRedistError, verifySha256,
  PHP_VERSION, PHP_ZIP_NAME, PHP_DOWNLOAD_URLS, PHP_SHA256,
} = require('../php-runtime.cjs');
```

E, antes de `console.log('\nphp-smoke OK')`, adicionar:

```javascript
  // Constantes do runtime fixadas
  assert(PHP_VERSION === '8.5.8', 'versão fixada 8.5.8');
  assert(PHP_ZIP_NAME === 'php-8.5.8-nts-Win32-vs17-x64.zip', 'nome do zip correto');
  assert(/^[a-f0-9]{64}$/i.test(PHP_SHA256), 'PHP_SHA256 é 64 hex');
  assert(Array.isArray(PHP_DOWNLOAD_URLS) && PHP_DOWNLOAD_URLS.length >= 1
    && PHP_DOWNLOAD_URLS.every((u) => u.endsWith(PHP_ZIP_NAME)), 'URLs terminam no zip fixado');
  console.log('constantes ok');
```

- [ ] **Step 3: Rodar o smoke e ver falhar**

Run: `npm run test:php`
Expected: FAIL — `PHP_VERSION` é `undefined` (assert "versão fixada 8.5.8").

- [ ] **Step 4: Implementar constantes + download/extract em `php-runtime.cjs`**

Adicionar ao `php-runtime.cjs`, antes do `module.exports`, os requires extras no topo do arquivo (`https`, `child_process`) e o bloco:

No topo, junto aos requires existentes:

```javascript
const https = require('https');
const { spawnSync } = require('child_process');
```

Bloco novo (antes do `module.exports`):

```javascript
// --- Runtime PHP sob demanda -------------------------------------------
const PHP_VERSION = '8.5.8';
const PHP_ZIP_NAME = `php-${PHP_VERSION}-nts-Win32-vs17-x64.zip`;
// COLE aqui o valor de 64 hex obtido no Step 1 deste task:
const PHP_SHA256 = 'COLE_O_SHA256_DE_64_HEX_AQUI';
const PHP_DOWNLOAD_URLS = [
  `https://windows.php.net/downloads/releases/${PHP_ZIP_NAME}`,
  `https://windows.php.net/downloads/releases/archives/${PHP_ZIP_NAME}`,
];

function downloadTo(url, destPath, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      const { statusCode, headers } = res;
      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error('excesso de redirects'));
        const next = new URL(headers.location, url).toString();
        return resolve(downloadTo(next, destPath, redirectsLeft - 1));
      }
      if (statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${statusCode} ao baixar ${url}`)); }
      const out = fs.createWriteStream(destPath);
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve()));
      out.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('timeout no download do PHP')));
  });
}

async function downloadFirstAvailable(urls, destPath) {
  let lastErr;
  for (const u of urls) {
    try { await downloadTo(u, destPath); return u; }
    catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('nenhuma URL de download disponível');
}

function extractZip(zipPath, destDir) {
  // Windows: usa o Expand-Archive do PowerShell (sem dependência npm).
  const r = spawnSync('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`,
  ], { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error('falha ao extrair o PHP: ' + (r.stderr || r.error?.message || 'erro desconhecido'));
  }
}

async function ensurePhpRuntime({ cacheBaseDir, onPhase }) {
  const phase = (m) => { if (onPhase) onPhase(m); };
  const versionDir = path.join(cacheBaseDir, PHP_VERSION);
  const phpExe = path.join(versionDir, 'php.exe');
  if (fs.existsSync(phpExe)) return phpExe;                 // cache hit

  fs.mkdirSync(versionDir, { recursive: true });
  const zipPath = path.join(versionDir, PHP_ZIP_NAME);

  phase('Baixando PHP (primeira vez)…');
  try {
    await downloadFirstAvailable(PHP_DOWNLOAD_URLS, zipPath);
  } catch (e) {
    try { fs.rmSync(zipPath, { force: true }); } catch {}
    throw new Error('Não foi possível baixar o PHP (verifique a conexão). ' + e.message);
  }

  phase('Verificando o download…');
  const ok = await verifySha256(zipPath, PHP_SHA256);
  if (!ok) {
    try { fs.rmSync(zipPath, { force: true }); } catch {}
    throw new Error('Checksum do PHP não confere — download abortado por segurança.');
  }

  phase('Extraindo o PHP…');
  extractZip(zipPath, versionDir);
  try { fs.rmSync(zipPath, { force: true }); } catch {}

  if (!fs.existsSync(phpExe)) {
    throw new Error('php.exe não encontrado após a extração.');
  }
  return phpExe;
}
```

Atualizar o `module.exports` para incluir os novos nomes:

```javascript
module.exports = {
  detectProjectType, resolvePhpDocroot, buildPhpServeArgs,
  isVcRedistError, verifySha256,
  PHP_VERSION, PHP_ZIP_NAME, PHP_DOWNLOAD_URLS, PHP_SHA256, ensurePhpRuntime,
};
```

- [ ] **Step 5: Substituir o placeholder do sha256**

Trocar `'COLE_O_SHA256_DE_64_HEX_AQUI'` pelo valor de 64 hex obtido no Step 1. Conferir que tem exatamente 64 caracteres hex minúsculos.

- [ ] **Step 6: Rodar o smoke e ver passar**

Run: `npm run test:php`
Expected: PASS — inclui a linha `constantes ok`. (O download real NÃO é exercido no smoke; é verificado manualmente no Task 6.)

- [ ] **Step 7: Commit**

```bash
git add php-runtime.cjs scripts/php-smoke.cjs
git commit -m "feat: baixar/cachear runtime PHP sob demanda com verificação sha256

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Ramo `php` no `preview:start` (integração no main.js)

**Files:**
- Modify: `main.js` (require do módulo; ramo `php` no handler `preview:start` ~2240)

**Interfaces:**
- Consumes: `detectProjectType`, `resolvePhpDocroot`, `buildPhpServeArgs`, `isVcRedistError`, `ensurePhpRuntime` (Tasks 1-2); e as funções já existentes no main.js: `pickFreePort`, `probePort`, `runningServers`, `sendPhase`, `sendLog`, `safeSend`, `killProc`.
- Produces: comportamento — quando `detectProjectType(projectPath) === 'php'`, sobe `php -S` reusando o motor atual.

Este task não tem teste automatizado (integração no processo Electron); a verificação é manual no Task 6. Fazer edições cirúrgicas.

- [ ] **Step 1: Importar o módulo no topo do main.js**

Perto dos outros `require` no topo de `main.js`, adicionar:

```javascript
const phpRuntime = require('./php-runtime.cjs');
```

- [ ] **Step 2: Ramificar o `preview:start` por tipo de projeto**

Em `main.js`, no `ipcMain.handle('preview:start', …)` (~2240), logo após o bloco que trata `runningServers.has(projectPath)` (as ~5 primeiras linhas do handler) e ANTES da linha `const cmd = detectDevCommand(projectPath);`, inserir:

```javascript
  // Ramifica por tipo de projeto. Node é o fluxo de sempre (abaixo, INTOCADO).
  const projectType = phpRuntime.detectProjectType(projectPath);
  if (projectType === 'php') {
    return startPhpPreview(projectPath);
  }
```

O restante do handler (a partir de `const cmd = detectDevCommand(projectPath);`) permanece exatamente como está — é o ramo Node.

- [ ] **Step 3: Implementar `startPhpPreview` reusando o motor**

Adicionar, logo ACIMA do `ipcMain.handle('preview:start', …)`, a função:

```javascript
async function startPhpPreview(projectPath) {
  const entry = { proc: null, url: null, port: null, log: '' };
  runningServers.set(projectPath, entry);

  // 1) Garante o runtime PHP (baixa na 1ª vez).
  let phpExe;
  try {
    const cacheBaseDir = path.join(app.getPath('userData'), 'runtimes', 'php');
    phpExe = await phpRuntime.ensurePhpRuntime({
      cacheBaseDir,
      onPhase: (m) => sendPhase(projectPath, m),
    });
  } catch (e) {
    runningServers.delete(projectPath);
    sendLog(projectPath, '\n[erro] ' + e.message + '\n');
    return { error: e.message };
  }

  // 2) Porta livre + php -S no docroot certo.
  const port = await pickFreePort();
  entry.chosenPort = port;
  const docroot = phpRuntime.resolvePhpDocroot(projectPath);
  const args = phpRuntime.buildPhpServeArgs({ port, docroot });
  console.log(`[preview:php] ${path.basename(projectPath)} -> porta ${port} | php ${args.join(' ')}`);
  sendPhase(projectPath, `Porta livre escolhida: ${port}`);
  sendPhase(projectPath, `Subindo: php ${args.join(' ')}`);

  const startedAt = Date.now();
  const proc = spawn(phpExe, args, { cwd: projectPath, env: { ...process.env } });
  entry.proc = proc;

  const markReady = (foundPort) => {
    if (entry.url) return;
    entry.port = foundPort;
    entry.url = `http://localhost:${foundPort}`;
    if (entry.probe) { clearInterval(entry.probe); entry.probe = null; }
    console.log(`[preview:php] ${path.basename(projectPath)} pronto em ${entry.url}`);
    sendPhase(projectPath, `Preview pronto em ${entry.url}`);
    safeSend('preview:ready', { projectPath, url: entry.url });
  };

  const onData = (d) => { const s = d.toString(); entry.log += s; sendLog(projectPath, s); };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);

  // Probe determinístico: a porta que escolhemos e forçamos.
  entry.probe = setInterval(async () => {
    if (entry.url) return;
    if (await probePort(port)) markReady(port);
  }, 600);

  proc.on('exit', (code) => {
    if (entry.probe) { clearInterval(entry.probe); entry.probe = null; }
    if (!entry.url) {
      const elapsedMs = Date.now() - startedAt;
      if (phpRuntime.isVcRedistError({ log: entry.log, elapsedMs })) {
        sendLog(projectPath,
          '\n[PHP não pôde iniciar] Falta o "Visual C++ Redistributable" da Microsoft.\n' +
          'Instale o VC redist x64 e tente de novo:\n' +
          'https://aka.ms/vs/17/release/vc_redist.x64.exe\n');
      } else {
        sendLog(projectPath, `\n[servidor PHP encerrou sem subir — código ${code}]\n`);
      }
    }
    runningServers.delete(projectPath);
    safeSend('preview:exit', { projectPath });
  });
  proc.on('error', (e) => sendLog(projectPath, '\n[erro ao iniciar php] ' + e.message + '\n'));

  return { running: true, starting: true, cmd: `php ${args.join(' ')}` };
}
```

> Nota de reuso: `pickFreePort`, `probePort`, `runningServers`, `sendPhase`, `sendLog`, `safeSend`, `spawn`, `app`, `path` já existem no `main.js`. Não redeclarar. O `preview:stop`/`preview:status`/`preview:log:get` já funcionam para qualquer entrada em `runningServers`, incluindo a do PHP — nada a mudar.

- [ ] **Step 4: Build + verificação de fumaça manual do main**

Run: `npm run build`
Expected: build conclui sem erros de sintaxe (o Vite compila o renderer; o `main.js` é validado ao subir o app — confirmar que não há erro de parse rodando `node --check main.js`).

Run: `node --check main.js`
Expected: sem saída (sintaxe ok).

- [ ] **Step 5: Commit**

```bash
git add main.js
git commit -m "feat: ramo php no preview:start (php -S) reusando o motor de preview

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `previewType` no `projects:list` (main.js)

**Files:**
- Modify: `main.js` (`ipcMain.handle('projects:list', …)` ~629)

**Interfaces:**
- Consumes: `detectProjectType` (Task 1).
- Produces: cada item de `projects:list` ganha `previewType: 'node' | 'php' | null`. O campo `hasPkg` permanece.

- [ ] **Step 1: Adicionar `previewType` ao objeto retornado**

Em `main.js`, no `.map((p) => { … })` do `projects:list`, dentro do objeto retornado (junto de `hasPkg`, `running`, etc.), adicionar a linha:

```javascript
        previewType: phpRuntime.detectProjectType(p),
```

O campo `hasPkg` (calculado com `fs.accessSync(path.join(p, 'package.json'))`) NÃO muda.

- [ ] **Step 2: Verificar sintaxe**

Run: `node --check main.js`
Expected: sem saída.

- [ ] **Step 3: Commit**

```bash
git add main.js
git commit -m "feat: projects:list expõe previewType (node|php|null), aditivo ao hasPkg

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: UI aditiva — `canPreview` no lugar dos gates de `hasPkg`

**Files:**
- Modify: `src/App.jsx` (~456)
- Modify: `src/components/PreviewPanel.jsx` (~723 e ~1062)

**Interfaces:**
- Consumes: `active.previewType` (Task 4).
- Produces: gates de UI liberam o preview para `node` **ou** `php`.

- [ ] **Step 1: App.jsx — trocar o gate `active?.hasPkg`**

Em `src/App.jsx`, a linha ~456:

```jsx
        {active?.hasPkg && (
```

passa a ser:

```jsx
        {active?.previewType != null && (
```

- [ ] **Step 2: PreviewPanel.jsx — gate do modo `empty` (~723)**

Em `src/components/PreviewPanel.jsx`, a linha ~723:

```jsx
      if (!active.hasPkg) { setMode('empty'); return; }
```

passa a ser:

```jsx
      if (active.previewType == null) { setMode('empty'); return; }
```

- [ ] **Step 3: PreviewPanel.jsx — mensagem do EmptyState (~1062)**

Em `src/components/PreviewPanel.jsx`, o trecho (~1062):

```jsx
                  {active.hasPkg
                    ? t('preview.no_preview')
                    : t('preview.no_preview_server')}
```

passa a ser:

```jsx
                  {active.previewType != null
                    ? t('preview.no_preview')
                    : t('preview.no_preview_server')}
```

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: build sem erros.

- [ ] **Step 5: Commit**

```bash
git add src/App.jsx src/components/PreviewPanel.jsx
git commit -m "feat: UI usa previewType (canPreview) pra liberar preview node ou php

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Verificação manual ponta a ponta

**Files:** nenhum (validação).

Este task confirma o comportamento real no app. Requer o app buildado e um projeto PHP de teste (ex.: a pasta `joiamisticalaroye/` que tem `public/index.php`).

- [ ] **Step 1: Build e subir o app**

Run: `npm run build`
Depois abrir o app (Electron). Lembrar de limpar `ELECTRON_RUN_AS_NODE` se abrir de um terminal do Claude. **Não** forçar relaunch se houver sessão viva — confirmar com o usuário.

- [ ] **Step 2: Regressão do Node (não pode quebrar)**

Abrir um projeto Node existente e clicar em rodar o preview.
Expected: sobe igual a antes (dependências instalam na 1ª vez, porta livre, webview aponta). Nenhuma mudança de comportamento.

- [ ] **Step 3: 1º download do PHP + preview**

Abrir a pasta `joiamisticalaroye/` (tem `public/index.php`) como projeto. Clicar em rodar.
Expected no log do preview, em ordem:
- `Baixando PHP (primeira vez)…`
- `Verificando o download…`
- `Extraindo o PHP…`
- `Porta livre escolhida: <n>`
- `Subindo: php -S 127.0.0.1:<n> -t <...>\public`
- `Preview pronto em http://localhost:<n>`
E o webview mostra a página PHP renderizada.

- [ ] **Step 4: 2ª execução usa o cache (sem baixar)**

Parar e rodar o preview PHP de novo (ou reabrir o app e rodar).
Expected: NÃO aparece "Baixando PHP" — vai direto pra "Porta livre escolhida". Confirmar que existe `…\AppData\Roaming\<app>\runtimes\php\8.5.8\php.exe`.

- [ ] **Step 5: Projeto sem preview**

Abrir uma pasta sem `package.json` (com script) e sem `.php`.
Expected: `previewType` nulo → botão de rodar não aparece / EmptyState mostra `no_preview_server`. Comportamento idêntico ao de hoje.

- [ ] **Step 6: (Opcional) Erro de VC redist**

Se possível testar num Windows sem VC redist x64: rodar um projeto PHP.
Expected: o `php.exe` sai na hora e o log mostra a orientação com o link `https://aka.ms/vs/17/release/vc_redist.x64.exe`. (Se não houver como testar, apenas revisar o código do classificador no Task 1/3.)

- [ ] **Step 7: Commit final (se necessário)**

Se algum ajuste foi feito durante a verificação, commitar. Caso contrário, o feature está completo na branch `feat/preview-php-puro`.

```bash
git add -A
git commit -m "chore: ajustes da verificação manual do preview PHP

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Notas de reuso e riscos

- **Motor reusado sem duplicar:** `pickFreePort`, `probePort`, `runningServers`, `preview:stop/status/log:get`, `sendPhase/sendLog/safeSend` servem os dois ramos. O ramo PHP replica só o mínimo de wiring de `spawn`/probe porque o handler Node embute esse trecho inline (não é uma função extraível hoje) — a alternativa (refatorar o Node pra compartilhar) violaria "Node intocado". Se no futuro o wiring for extraído, os dois ramos convergem.
- **`Expand-Archive`** existe no Windows PowerShell 5.1 (padrão no Win10/11). É Windows-only — coerente com o build-alvo.
- **URL do PHP muda com o tempo:** por isso `PHP_DOWNLOAD_URLS` tenta `/releases/` e cai pra `/releases/archives/`. Ao subir a versão fixada no futuro, atualizar `PHP_VERSION` + `PHP_SHA256` juntos.
- **Redirect no download:** `windows.php.net` redireciona pra `downloads.php.net`; `downloadTo` segue redirects (inclusive cross-host).
