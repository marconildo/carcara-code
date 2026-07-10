# Onboarding Scaffold Wizard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Quando um projeto abre numa pasta vazia/só-lixo, mostrar cards de stack web no lugar do "Nenhum servidor de preview"; ao clicar, rodar o CLI oficial não-interativo, e deixar o preview subir.

**Architecture:** Decisão pura (catálogo + regras) em `electron/scaffold-core.cjs` (testável no smoke). Execução (spawn do create-*, merge de arquivos) em handlers IPC novos no `main.js`, rastreada por-projeto num `Map`. A **instalação de deps e a subida do dev server são delegadas ao `preview:start` já existente** (DRY) — o motor de scaffold só cria os arquivos. UI num componente novo `ScaffoldWizard.jsx`, montado dentro do `PreviewPanel` no ramo `mode === 'empty'` quando o probe diz que a pasta é scaffoldável.

**Tech Stack:** Electron (main CJS + preload contextBridge), React (Vite), Tailwind, i18n caseiro (`useT`), lucide-react. Testes puros via `scripts/platform-smoke.cjs` (`node scripts/platform-smoke.cjs`). Sem framework de teste no renderer/main — verificação de UI/spawn é **smoke manual** (padrão do projeto).

## Global Constraints

- **Plataforma primária: Windows.** O caminho Windows nunca deve regredir. Mac/Linux são secundários.
- **Diferença de SO só em `electron/platform.cjs`.** Este plano não introduz `process.platform` fora de lá.
- **Edições em `src/` só aparecem após `npm run build`** (o app carrega de `dist/`). Toda verificação de UI exige build antes.
- **Não forçar relaunch do app** sem confirmar — pode haver sessão viva do Claude. Build sempre; pedir ao usuário pra reabrir.
- **Smoke manual com UMA instância só** (ver DESAFIOS.md): antes de testar, conferir que não há Electron antigo aberto.
- **Catálogo v1 (fixo, hardcoded, só web):** `vite-react`, `next`, `astro`, `html`. Nada de backend/mobile/desktop.
- **Comandos não-interativos exatos (não alterar as flags — são anti-prompt):**
  - `vite-react`: `npm create vite@latest . -- --template react`
  - `next`: `npx create-next-app@latest . --ts --tailwind --eslint --app --src-dir --import-alias @/* --use-npm --skip-install --yes`
  - `astro`: `npm create astro@latest . -- --template basics --no-install --no-git --skip-houston -y`
  - `html`: `npm create vite@latest . -- --template vanilla`
- **Lixo tolerado numa pasta "scaffoldável" (case-insensitive):** `.git`, `.gitignore`, `README.md`, `LICENSE`. Qualquer outra coisa ⇒ não scaffoldável.
- **Nunca deletar arquivo do usuário.** Colisão ⇒ mover o original pra `_backup/`.

---

## Desvios da spec descobertos ao planejar (ler antes de executar)

A spec (`docs/specs/2026-07-10-onboarding-scaffold-wizard-design.md`) descreve o motor de outro jeito; ao planejar, três coisas mudaram por robustez/DRY. **Estão embutidas nas tarefas abaixo:**

1. **Scaffold num tempdir vazio e depois merge → projeto**, em vez de "limpar conflitos pra `_backup/` antes do spawn". Motivo: mover o README pra `_backup` não silencia o `create-vite`/`create-astro`, que ainda veem `.git` e podem perguntar "diretório não está vazio". Rodar o create-* num `.carcara-scaffold/` **sempre vazio** elimina qualquer prompt de forma uniforme, independente de versão do CLI (lição do DESAFIOS: não depender de comportamento de CLI que a gente "acha" que é).
2. **Instalação de deps + subida do dev server delegadas ao `preview:start` existente.** O motor de scaffold só gera arquivos e emite `scaffold:done`; o wizard então chama `window.api.startPreview(...)`, que já faz `needsInstall`+`npm install`+porta+spawn+`preview:ready`. Evita duplicar toda a engine de preview. Por isso os create-* levam `--skip-install`/`--no-install`: a instalação acontece **uma vez**, no diretório final, via preview.
3. **`html` = `create-vite --template vanilla`** (HTML/CSS/JS puro **com** Vite), não arquivos escritos à mão sem npm. Motivo: o Preview do app é um webview servido por dev server; um `index.html` estático sem servidor não se integra (e perde live-reload). O template `vanilla` entrega exatamente HTML/CSS/JS que o usuário edita, roda no mesmo motor de preview, e mantém o catálogo 100% "CLI" (um só caminho no motor).

⚠️ **Ponto 3 é uma mudança de decisão aprovada na spec** ("HTML puro: arquivos, sem npm"). Se o usuário quiser mesmo o estático-sem-npm, é outro plano (precisa de suporte a `file://`/servidor estático no preview). O plano abaixo assume `vanilla`.

---

## Estrutura de arquivos

| Arquivo                              | Responsabilidade                                                                                                                                    |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `electron/scaffold-core.cjs`         | **Novo.** Decisão pura: catálogo, `commandFor`, `isScaffoldable`, `junkPresent`, `mergePlan`, `listStacks`. Sem `fs`/`child_process`.               |
| `scripts/platform-smoke.cjs`         | **Modificar.** Assertivas do `scaffold-core`.                                                                                                       |
| `main.js`                            | **Modificar.** Handlers `scaffold:probe` / `scaffold:run` / `scaffold:status` / `scaffold:stacks` + `runningScaffolds` Map + merge tempdir→projeto. |
| `preload.js`                         | **Modificar.** Expor `scaffoldProbe`/`scaffoldRun`/`scaffoldStatus`/`scaffoldStacks` (o `api.on` genérico já cobre os eventos).                     |
| `src/lib/locales/pt.json`, `en.json` | **Modificar.** Namespace `scaffold.*`.                                                                                                              |
| `src/components/ScaffoldWizard.jsx`  | **Novo.** UI: máquina de estados pick → confirm → running → error.                                                                                  |
| `src/components/PreviewPanel.jsx`    | **Modificar.** Probe ao entrar no `empty`; render do wizard OU do EmptyState atual.                                                                 |

---

## Task 1: `scaffold-core.cjs` — decisão pura + smoke

**Files:**

- Create: `electron/scaffold-core.cjs`
- Test: `scripts/platform-smoke.cjs` (append)

**Interfaces:**

- Consumes: nada.
- Produces:
  - `SCAFFOLD_JUNK: Set<string>` (lowercase)
  - `CATALOG: Array<{ id, label, sub, icon, command: string[] }>`
  - `listStacks(): Array<{ id, label, sub, icon }>` (sem `command`)
  - `commandFor(stackId: string): string[] | null`
  - `isScaffoldable(entries: string[]): boolean`
  - `junkPresent(entries: string[]): string[]`
  - `mergePlan(existing: string[], generated: string[]): { backup: string[], move: string[] }`

- [ ] **Step 1: Escrever as assertivas (teste que falha) no fim do `scripts/platform-smoke.cjs`**

Inserir ANTES da linha final que dispara o IIFE `(async () => { ... })()` — na verdade, mais simples: inserir logo depois do bloco `macMenuTemplate`/`fixLoginPath` e antes do `console.log('platform-smoke OK')` NÃO existe (o OK está dentro do IIFE). Colocar este bloco **logo após a linha 51** (as asserts de `roles`), que roda no topo, síncrono:

```js
// --- scaffold-core (onboarding) ---
const sc = require('../electron/scaffold-core.cjs');
assert(sc.isScaffoldable([]) === true, 'pasta vazia é scaffoldável');
assert(sc.isScaffoldable(['.git']) === true, 'só .git é scaffoldável');
assert(sc.isScaffoldable(['README.md']) === true, 'só README é scaffoldável');
assert(
  sc.isScaffoldable(['.git', 'README.md', 'LICENSE', '.gitignore']) === true,
  'só-lixo é scaffoldável',
);
assert(sc.isScaffoldable(['package.json']) === false, 'package.json não é scaffoldável');
assert(sc.isScaffoldable(['src']) === false, 'src não é scaffoldável');
assert(sc.isScaffoldable(['index.html']) === false, 'index.html não é scaffoldável');
assert(sc.isScaffoldable(['meus-pdfs']) === false, 'pasta com conteúdo não é scaffoldável');
assert(
  sc.commandFor('vite-react')[0] === 'npm' && sc.commandFor('vite-react').includes('react'),
  'vite-react argv',
);
assert(
  sc.commandFor('next').includes('--import-alias') && sc.commandFor('next').includes('@/*'),
  'next tem import-alias (anti-prompt)',
);
assert(sc.commandFor('next').includes('--skip-install'), 'next não instala no scaffold');
assert(
  sc.commandFor('astro').includes('--no-install') &&
    sc.commandFor('astro').includes('--skip-houston'),
  'astro no-install + skip-houston',
);
assert(sc.commandFor('html').includes('vanilla'), 'html = vite vanilla');
assert(sc.commandFor('inexistente') === null, 'id desconhecido -> null');
assert(sc.listStacks().length === 4, '4 cards');
assert(
  sc.listStacks().every((s) => !('command' in s)),
  'listStacks não vaza argv',
);
const mp = sc.mergePlan(['README.md', '.git'], ['README.md', 'src', 'package.json']);
assert(
  JSON.stringify(mp.backup) === JSON.stringify(['README.md']),
  'merge: README colide -> backup',
);
assert(mp.move.length === 3, 'merge: move tudo que foi gerado');
console.log('scaffold-core OK');
```

- [ ] **Step 2: Rodar o smoke e ver falhar**

Run: `node scripts/platform-smoke.cjs`
Expected: FAIL — `Cannot find module '../electron/scaffold-core.cjs'`.

- [ ] **Step 3: Criar `electron/scaffold-core.cjs`**

```js
'use strict';
// Decisão pura do onboarding: catálogo de stacks web, comando de scaffold e
// regras de "pasta scaffoldável". SEM fs, SEM child_process — testável no
// scripts/platform-smoke.cjs (padrão do CLAUDE.md).

// Nomes tolerados numa pasta "vazia ou só-lixo" (case-insensitive).
const SCAFFOLD_JUNK = new Set(['.git', '.gitignore', 'readme.md', 'license']);

// Catálogo fixo (v1: só web). Ordem = ordem dos cards.
// Todos 'cli': rodam o create-* oficial SEM instalar (o install roda depois,
// no preview:start, no diretório final — DRY).
const CATALOG = [
  {
    id: 'vite-react',
    label: 'React',
    sub: 'Vite',
    icon: 'Atom',
    command: ['npm', 'create', 'vite@latest', '.', '--', '--template', 'react'],
  },
  {
    id: 'next',
    label: 'Next.js',
    sub: 'App Router + Tailwind',
    icon: 'Triangle',
    command: [
      'npx',
      'create-next-app@latest',
      '.',
      '--ts',
      '--tailwind',
      '--eslint',
      '--app',
      '--src-dir',
      '--import-alias',
      '@/*',
      '--use-npm',
      '--skip-install',
      '--yes',
    ],
  },
  {
    id: 'astro',
    label: 'Astro',
    sub: 'Sites de conteúdo',
    icon: 'Rocket',
    command: [
      'npm',
      'create',
      'astro@latest',
      '.',
      '--',
      '--template',
      'basics',
      '--no-install',
      '--no-git',
      '--skip-houston',
      '-y',
    ],
  },
  {
    id: 'html',
    label: 'HTML/CSS/JS',
    sub: 'Vite vanilla',
    icon: 'FileCode',
    command: ['npm', 'create', 'vite@latest', '.', '--', '--template', 'vanilla'],
  },
];

const BY_ID = new Map(CATALOG.map((s) => [s.id, s]));

function listStacks() {
  return CATALOG.map(({ id, label, sub, icon }) => ({ id, label, sub, icon }));
}

function commandFor(stackId) {
  const s = BY_ID.get(stackId);
  return s ? s.command.slice() : null;
}

function isScaffoldable(entries) {
  if (!Array.isArray(entries)) return false;
  return entries.every((name) => SCAFFOLD_JUNK.has(String(name).toLowerCase()));
}

function junkPresent(entries) {
  if (!Array.isArray(entries)) return [];
  return entries.filter((name) => SCAFFOLD_JUNK.has(String(name).toLowerCase()));
}

// Plano de merge do tempdir -> projeto. `existing`/`generated` = nomes de topo.
// backup: arquivos do usuário que colidem (vão pra _backup/, e o gerado vence).
// move: tudo que o scaffold gerou.
function mergePlan(existing, generated) {
  const have = new Set((existing || []).map((n) => String(n).toLowerCase()));
  const backup = (generated || []).filter((n) => have.has(String(n).toLowerCase()));
  return { backup, move: (generated || []).slice() };
}

module.exports = {
  SCAFFOLD_JUNK,
  CATALOG,
  listStacks,
  commandFor,
  isScaffoldable,
  junkPresent,
  mergePlan,
};
```

- [ ] **Step 4: Rodar o smoke e ver passar**

Run: `node scripts/platform-smoke.cjs`
Expected: PASS — imprime `scaffold-core OK` e depois `platform-smoke OK`.

- [ ] **Step 5: Commit**

```bash
git add electron/scaffold-core.cjs scripts/platform-smoke.cjs
git commit -m "feat(scaffold): catálogo puro de stacks + regras de pasta scaffoldável"
```

---

## Task 2: motor no `main.js` + canais no `preload.js`

**Files:**

- Modify: `main.js` (adicionar seção após o bloco `// ---------- Preview (dev server) ----------`, ex.: perto da linha 3520+; usa `spawn`, `fs`, `path`, `safeSend`, `ipcMain`, `cmdAvailable` — todos já existentes)
- Modify: `preload.js` (adicionar no objeto `api`, junto de `// Preview`, perto da linha 206)

**Interfaces:**

- Consumes (Task 1): `commandFor`, `isScaffoldable`, `junkPresent`, `mergePlan`, `listStacks` de `./electron/scaffold-core.cjs`.
- Consumes (existentes no `main.js`): `cmdAvailable(cmd): boolean`, `safeSend(channel, payload)`, `spawn`, `fs`, `path`.
- Produces (IPC handlers):
  - `scaffold:probe` `({ projectPath }) → { scaffoldable: boolean, junk: string[] }`
  - `scaffold:stacks` `() → Array<{ id, label, sub, icon }>`
  - `scaffold:status` `({ projectPath }) → { phase: 'scaffolding' } | null`
  - `scaffold:run` `({ projectPath, stackId }) → { ok: true } | { error: 'already-running'|'unknown-stack'|'not-scaffoldable'|'missing-node'|'scaffold-failed', message?: string }`
  - Eventos push: `scaffold:progress` `({ projectPath, phase, line })`, `scaffold:done` `({ projectPath })`, `scaffold:error` `({ projectPath, message, log })`
- Produces (preload, no `window.api`):
  - `scaffoldProbe(projectPath)`, `scaffoldStacks()`, `scaffoldStatus(projectPath)`, `scaffoldRun(projectPath, stackId)`

- [ ] **Step 1: Adicionar a seção de scaffold no `main.js`**

Inserir este bloco logo após a seção de preview (depois da função/handler de preview; qualquer ponto no escopo de módulo após `cmdAvailable` estar definido — ex.: após a linha ~3521, antes de `// ---------- Preview (dev server) ----------`, ou logo depois dela). Requer que `cmdAvailable` já esteja definido acima (está, na seção Preview):

```js
// ---------- Onboarding: scaffold de projeto novo ----------
const scaffoldCore = require('./electron/scaffold-core.cjs');
const runningScaffolds = new Map(); // projectPath -> { phase }

function readEntries(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function sendScaffold(projectPath, phase, line) {
  safeSend('scaffold:progress', { projectPath, phase, line: line || '' });
}

// Move o que o create-* gerou (no tempdir) pro projeto. Arquivo do usuário que
// colide vai pra _backup/ (nunca deleta); o gerado vence.
function mergeScaffold(tempDir, projectPath, plan) {
  const backupDir = path.join(projectPath, '_backup');
  for (const name of plan.backup) {
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    fs.renameSync(path.join(projectPath, name), path.join(backupDir, name));
  }
  for (const name of plan.move) {
    fs.renameSync(path.join(tempDir, name), path.join(projectPath, name));
  }
}

ipcMain.handle('scaffold:stacks', () => scaffoldCore.listStacks());

ipcMain.handle('scaffold:probe', (_evt, { projectPath }) => {
  const entries = readEntries(projectPath);
  return {
    scaffoldable: scaffoldCore.isScaffoldable(entries),
    junk: scaffoldCore.junkPresent(entries),
  };
});

ipcMain.handle('scaffold:status', (_evt, { projectPath }) => {
  return runningScaffolds.get(projectPath) || null;
});

ipcMain.handle('scaffold:run', async (_evt, { projectPath, stackId }) => {
  if (runningScaffolds.has(projectPath)) return { error: 'already-running' };
  const command = scaffoldCore.commandFor(stackId);
  if (!command) return { error: 'unknown-stack' };

  // Re-checa na hora: a pasta pode ter deixado de ser scaffoldável por fora.
  if (!scaffoldCore.isScaffoldable(readEntries(projectPath))) {
    return { error: 'not-scaffoldable' };
  }
  if (!(cmdAvailable('node') && cmdAvailable('npm'))) {
    return { error: 'missing-node' };
  }

  const state = { phase: 'scaffolding' };
  runningScaffolds.set(projectPath, state);
  sendScaffold(projectPath, 'scaffolding');

  // tempdir SEMPRE vazio -> os create-* rodam sem prompt de "diretório não vazio".
  const tempDir = path.join(projectPath, '.carcara-scaffold');
  let log = '';
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.mkdirSync(tempDir, { recursive: true });

    const code = await new Promise((resolve) => {
      const proc = spawn(command[0], command.slice(1), {
        cwd: tempDir,
        shell: true,
        env: { ...process.env, CI: '1' },
      });
      const onData = (d) => {
        const s = d.toString();
        log += s;
        sendScaffold(projectPath, 'scaffolding', s);
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', onData);
      proc.on('exit', (c) => resolve(c));
      proc.on('error', (e) => {
        log += '\n' + e.message + '\n';
        resolve(1);
      });
    });
    if (code !== 0) throw new Error(`create falhou (código ${code})`);

    const generated = readEntries(tempDir);
    const plan = scaffoldCore.mergePlan(readEntries(projectPath), generated);
    mergeScaffold(tempDir, projectPath, plan);
    fs.rmSync(tempDir, { recursive: true, force: true });

    runningScaffolds.delete(projectPath);
    safeSend('scaffold:done', { projectPath });
    return { ok: true };
  } catch (e) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    runningScaffolds.delete(projectPath);
    safeSend('scaffold:error', { projectPath, message: e.message, log });
    return { error: 'scaffold-failed', message: e.message };
  }
});
```

- [ ] **Step 2: Expor os canais no `preload.js`**

Adicionar dentro do objeto passado a `contextBridge.exposeInMainWorld('api', { ... })`, logo após o bloco `// Preview` (perto da linha 206):

```js
  // Onboarding (scaffold de projeto novo)
  scaffoldStacks: () => ipcRenderer.invoke('scaffold:stacks'),
  scaffoldProbe: (projectPath) => ipcRenderer.invoke('scaffold:probe', { projectPath }),
  scaffoldStatus: (projectPath) => ipcRenderer.invoke('scaffold:status', { projectPath }),
  scaffoldRun: (projectPath, stackId) => ipcRenderer.invoke('scaffold:run', { projectPath, stackId }),
```

(Os eventos `scaffold:progress`/`scaffold:done`/`scaffold:error` chegam pelo `api.on(channel, cb)` genérico que já existe — não precisa de código novo no preload.)

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: build conclui sem erro (Vite empacota o renderer; main/preload não precisam de build, mas o comando não pode quebrar).

- [ ] **Step 4: Smoke manual do motor (sem UI ainda)**

Garantir UMA instância do app (ver DESAFIOS.md). Pedir ao usuário pra reabrir o app após o build. No DevTools do renderer (Ctrl+Shift+I), com uma **pasta de teste vazia** já adicionada como projeto (caminho `P`):

```js
await window.api.scaffoldProbe('P'); // => { scaffoldable: true, junk: [] }
await window.api.scaffoldStacks(); // => 4 objetos { id, label, sub, icon }
const off = window.api.on('scaffold:progress', (d) =>
  console.log('progress', d.phase, d.line?.slice(0, 80)),
);
window.api.on('scaffold:done', (d) => console.log('DONE', d));
window.api.on('scaffold:error', (d) => console.log('ERR', d));
await window.api.scaffoldRun('P', 'vite-react');
```

Expected: chega `DONE`; a pasta `P` passa a ter `package.json`, `src/`, `index.html`, `vite.config.js` (sem `node_modules` ainda). Rodar de novo `scaffoldProbe('P')` ⇒ `{ scaffoldable: false }`.

- [ ] **Step 5: Commit**

```bash
git add main.js preload.js
git commit -m "feat(scaffold): motor de scaffold (probe/run/status) + canais no preload"
```

---

## Task 3: strings i18n + `ScaffoldWizard.jsx`

**Files:**

- Modify: `src/lib/locales/pt.json`, `src/lib/locales/en.json` (novo objeto `scaffold`)
- Create: `src/components/ScaffoldWizard.jsx`

**Interfaces:**

- Consumes (Task 2, via `window.api`): `scaffoldStacks()`, `scaffoldStatus(projectPath)`, `scaffoldRun(projectPath, stackId)`, `startPreview(projectPath)`, e `api.on('scaffold:progress'|'scaffold:done'|'scaffold:error', cb)`.
- Consumes: `useT` de `@/lib/i18n`; `Button` de `./ui/button.jsx`; ícones `Atom, Triangle, Rocket, FileCode, Loader2, AlertTriangle, ChevronRight` de `lucide-react`.
- Produces: `export function ScaffoldWizard({ projectPath, junk })` — componente que renderiza a máquina de estados e se auto-desmonta quando o preview sobe (o `PreviewPanel` troca o `mode` pra `web` no `preview:ready`).

- [ ] **Step 1: Adicionar o namespace `scaffold` no `pt.json`**

Inserir uma chave `"scaffold": { ... }` no nível raiz do `src/lib/locales/pt.json` (ex.: logo antes de `"preview": {`):

```json
  "scaffold": {
    "title": "Começar um projeto novo",
    "subtitle": "Escolha uma tecnologia. O Carcará cria tudo e abre o preview.",
    "junk_notice": "Esta pasta tem {count} arquivo(s). Vou mantê-los e criar o projeto ao redor.",
    "confirm": "Criar projeto",
    "cancel": "Voltar",
    "creating": "Criando projeto…",
    "starting": "Instalando e iniciando o preview…",
    "error_title": "Não consegui criar o projeto",
    "error_details": "Ver detalhes",
    "retry": "Tentar de novo",
    "missing_node": "Para criar um projeto, instale o Node.js primeiro.",
    "not_scaffoldable": "Esta pasta deixou de estar vazia. Recarregue para continuar."
  },
```

- [ ] **Step 2: Adicionar o mesmo namespace (em inglês) no `en.json`**

Inserir no nível raiz do `src/lib/locales/en.json` (mesma posição relativa):

```json
  "scaffold": {
    "title": "Start a new project",
    "subtitle": "Pick a technology. Carcará sets everything up and opens the preview.",
    "junk_notice": "This folder has {count} file(s). I'll keep them and build the project around them.",
    "confirm": "Create project",
    "cancel": "Back",
    "creating": "Creating project…",
    "starting": "Installing and starting the preview…",
    "error_title": "Couldn't create the project",
    "error_details": "See details",
    "retry": "Try again",
    "missing_node": "To create a project, install Node.js first.",
    "not_scaffoldable": "This folder is no longer empty. Reload to continue."
  },
```

- [ ] **Step 3: Criar `src/components/ScaffoldWizard.jsx`**

```jsx
import { useEffect, useRef, useState } from 'react';
import {
  Atom,
  Triangle,
  Rocket,
  FileCode,
  Loader2,
  AlertTriangle,
  ChevronRight,
} from 'lucide-react';
import { Button } from './ui/button.jsx';
import { useT } from '@/lib/i18n';

const ICONS = { Atom, Triangle, Rocket, FileCode };

// Estados: 'pick' | 'confirm' | 'running' | 'error'
export function ScaffoldWizard({ projectPath, junk }) {
  const t = useT();
  const [stacks, setStacks] = useState([]);
  const [view, setView] = useState('pick');
  const [pending, setPending] = useState(null); // stackId escolhido, aguardando confirm
  const [phase, setPhase] = useState('scaffolding'); // 'scaffolding' | 'starting'
  const [error, setError] = useState(null); // { message, log }
  const [showLog, setShowLog] = useState(false);
  const junkCount = Array.isArray(junk) ? junk.length : 0;

  // Carrega catálogo e reconecta a um scaffold que já esteja rodando (background).
  useEffect(() => {
    let alive = true;
    window.api.scaffoldStacks().then((s) => alive && setStacks(s || []));
    window.api.scaffoldStatus(projectPath).then((st) => {
      if (alive && st && st.phase) {
        setView('running');
        setPhase(st.phase);
      }
    });
    return () => {
      alive = false;
    };
  }, [projectPath]);

  // Listeners dos eventos do motor (só do NOSSO projeto).
  const startPreviewRef = useRef(false);
  useEffect(() => {
    const offs = [];
    offs.push(
      window.api.on('scaffold:progress', ({ projectPath: p, phase: ph }) => {
        if (p !== projectPath) return;
        setPhase(ph || 'scaffolding');
      }),
    );
    offs.push(
      window.api.on('scaffold:done', async ({ projectPath: p }) => {
        if (p !== projectPath) return;
        setPhase('starting');
        if (startPreviewRef.current) return;
        startPreviewRef.current = true;
        const res = await window.api.startPreview(projectPath);
        // Se não há dev server pra subir, mostra erro amigável em vez de travar.
        if (res && res.error) {
          setError({ message: res.error, log: '' });
          setView('error');
        }
        // Sucesso: o PreviewPanel troca o modo pra 'web' no preview:ready e
        // este componente se desmonta. Nada mais a fazer aqui.
      }),
    );
    offs.push(
      window.api.on('scaffold:error', ({ projectPath: p, message, log }) => {
        if (p !== projectPath) return;
        setError({ message, log });
        setView('error');
      }),
    );
    return () => offs.forEach((off) => off && off());
  }, [projectPath]);

  const choose = (stackId) => {
    if (junkCount > 0) {
      setPending(stackId);
      setView('confirm');
    } else {
      run(stackId);
    }
  };

  const run = async (stackId) => {
    setError(null);
    setView('running');
    setPhase('scaffolding');
    startPreviewRef.current = false;
    const res = await window.api.scaffoldRun(projectPath, stackId);
    if (res && res.error) {
      const msg =
        res.error === 'missing-node'
          ? t('scaffold.missing_node')
          : res.error === 'not-scaffoldable'
            ? t('scaffold.not_scaffoldable')
            : res.message || t('scaffold.error_title');
      setError({ message: msg, log: '' });
      setView('error');
    }
  };

  if (view === 'error') {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
        <AlertTriangle className="text-destructive" />
        <div className="font-medium">{t('scaffold.error_title')}</div>
        <div className="max-w-md text-sm text-muted-foreground">{error?.message}</div>
        {error?.log ? (
          <>
            <button
              className="text-xs text-muted-foreground underline"
              onClick={() => setShowLog((v) => !v)}
            >
              {t('scaffold.error_details')}
            </button>
            {showLog && (
              <pre className="max-h-40 max-w-lg overflow-auto rounded bg-muted p-2 text-left font-mono text-[11px]">
                {error.log}
              </pre>
            )}
          </>
        ) : null}
        <Button variant="secondary" size="sm" onClick={() => setView('pick')}>
          {t('scaffold.retry')}
        </Button>
      </div>
    );
  }

  if (view === 'running') {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
        <Loader2 className="animate-spin text-primary" />
        <div className="text-sm text-muted-foreground">
          {phase === 'starting' ? t('scaffold.starting') : t('scaffold.creating')}
        </div>
      </div>
    );
  }

  if (view === 'confirm') {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-6 text-center">
        <div className="max-w-md text-sm text-muted-foreground">
          {t('scaffold.junk_notice', { count: junkCount })}
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => setView('pick')}>
            {t('scaffold.cancel')}
          </Button>
          <Button size="sm" onClick={() => run(pending)}>
            {t('scaffold.confirm')}
          </Button>
        </div>
      </div>
    );
  }

  // view === 'pick'
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-5 p-6">
      <div className="text-center">
        <div className="text-lg font-semibold">{t('scaffold.title')}</div>
        <div className="mt-1 text-sm text-muted-foreground">{t('scaffold.subtitle')}</div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {stacks.map((s) => {
          const Icon = ICONS[s.icon] || ChevronRight;
          return (
            <button
              key={s.id}
              onClick={() => choose(s.id)}
              className="flex w-44 items-center gap-3 rounded-lg border border-border bg-card p-3 text-left transition-colors hover:border-primary hover:bg-accent"
            >
              <Icon className="shrink-0 text-primary" />
              <div className="min-w-0">
                <div className="truncate font-medium">{s.label}</div>
                <div className="truncate text-xs text-muted-foreground">{s.sub}</div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Build (garante que o componente e o JSON compilam)**

Run: `npm run build`
Expected: build conclui sem erro. (O componente ainda não é montado por ninguém; este passo só valida sintaxe/imports/JSON.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/locales/pt.json src/lib/locales/en.json src/components/ScaffoldWizard.jsx
git commit -m "feat(scaffold): strings i18n + componente ScaffoldWizard"
```

---

## Task 4: montar o wizard no `PreviewPanel`

**Files:**

- Modify: `src/components/PreviewPanel.jsx` (import + estado de probe + render no ramo `mode === 'empty'`, perto da linha 1897)

**Interfaces:**

- Consumes (Task 3): `ScaffoldWizard` de `./ScaffoldWizard.jsx`.
- Consumes (Task 2, via `window.api`): `scaffoldProbe(projectPath)`.
- Consumes (existentes): estado `active` (objeto do projeto, tem `.path`), `mode`, `inPreview`, `EmptyState`, `t`, `copyClaudePrompt`, `copied`.

- [ ] **Step 1: Importar o componente**

Adicionar perto dos imports de componentes (ex.: após a linha 39, junto de `EmptyState`):

```jsx
import { ScaffoldWizard } from './ScaffoldWizard.jsx';
```

- [ ] **Step 2: Estado + probe ao entrar no `empty`**

Adicionar um estado (junto dos outros `useState`, ex.: perto da linha 431 onde `mode` é declarado):

```jsx
const [scaffoldProbe, setScaffoldProbe] = useState(null); // { scaffoldable, junk } | null
```

E um efeito que faz o probe quando o preview está vazio para um projeto ativo (colocar junto dos outros `useEffect`, ex.: após o bloco de listeners de IPC ~linha 1170):

```jsx
// Pasta vazia/só-lixo? Decide se o ramo "empty" mostra o wizard de scaffold.
useEffect(() => {
  if (!inPreview || mode !== 'empty' || !active) {
    setScaffoldProbe(null);
    return;
  }
  let alive = true;
  setScaffoldProbe(null);
  window.api.scaffoldProbe(active.path).then((r) => {
    if (alive) setScaffoldProbe(r || null);
  });
  return () => {
    alive = false;
  };
}, [inPreview, mode, active]);
```

- [ ] **Step 3: Renderizar wizard OU EmptyState no ramo `empty`**

Substituir o ramo `active ? (...)` do bloco `mode === 'empty'` (linhas ~1899-1910) para preferir o wizard quando scaffoldável:

```jsx
{
  inPreview &&
    mode === 'empty' &&
    (active ? (
      scaffoldProbe?.scaffoldable ? (
        <ScaffoldWizard projectPath={active.path} junk={scaffoldProbe.junk} />
      ) : (
        <div className="absolute inset-0">
          <EmptyState>
            {active.previewType != null ? t('preview.no_preview') : t('preview.no_preview_server')}
            <Button variant="secondary" size="sm" onClick={copyClaudePrompt} className="mt-1">
              <Copy className="mr-1" />
              {copied ? t('preview.prompt_copied') : t('preview.copy_prompt')}
            </Button>
          </EmptyState>
        </div>
      )
    ) : (
      <div className="absolute inset-0">
        <EmptyState size="lg">{t('preview.select_project')}</EmptyState>
      </div>
    ));
}
```

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: build conclui sem erro.

- [ ] **Step 5: Smoke manual completo (com o usuário)**

Garantir UMA instância; pedir ao usuário pra reabrir o app após o build. Roteiro:

1. **Pasta 100% vazia:** criar uma pasta vazia, adicionar como projeto, abrir o Preview. Esperado: os 4 cards aparecem no lugar de "Nenhum servidor de preview".
2. Clicar em **React**. Esperado: "Criando projeto…" → "Instalando e iniciando o preview…" → o app Vite aparece no webview (live). A pasta ganhou `package.json`, `src/`, `node_modules/`.
3. **Pasta só-lixo:** criar pasta com só um `README.md`, adicionar, abrir Preview → cards aparecem. Clicar em **Astro** → passo de confirmação ("Esta pasta tem 1 arquivo(s)…") → **Criar projeto** → Astro sobe no preview; o `README.md` original está preservado (em `_backup/` se o Astro gerou um próprio, senão intacto).
4. **Projeto existente:** abrir um projeto que já tem `package.json`. Esperado: **nenhum** card — segue o EmptyState/preview de sempre.
5. **Erro:** desligar a internet e clicar num card. Esperado: estado de erro com "Não consegui criar o projeto" + "Tentar de novo".

- [ ] **Step 6: Commit**

```bash
git add src/components/PreviewPanel.jsx
git commit -m "feat(scaffold): montar o ScaffoldWizard no ramo vazio do Preview"
```

---

## Self-Review (cobertura da spec)

- **Gatilho vazia/só-lixo** → `isScaffoldable`/`junkPresent` (Task 1) + probe (Task 4). ✓
- **Catálogo só-web (4 cards)** → `CATALOG` (Task 1); `html` via `--template vanilla` (ver Desvios, ponto 3). ✓ ⚠️ desvio sinalizado.
- **CLI oficial não-interativo** → `command` no catálogo, com as flags anti-prompt; `CI:1` no env (Task 1/2). ✓
- **Barra/estado de progresso, esconde terminal** → estados `running` do wizard (Task 3). Nota: install+start reusam `preview:start`, então a fase "starting" é indeterminada (não parseia texto do preview — lição do DESAFIOS). ✓ (desvio ponto 2)
- **Sair no meio → continua em background** → `runningScaffolds` Map + `scaffold:status` + reconexão no mount do wizard (Task 2/3). ✓
- **Nunca deletar; `_backup/`** → `mergePlan` + `mergeScaffold` (Task 1/2). ✓
- **Re-checar antes de escrever** → `scaffold:run` re-chama `isScaffoldable` (Task 2). ✓
- **Node ausente** → `cmdAvailable('node'/'npm')` → `missing-node` → mensagem no wizard (Task 2/3). ✓
- **Erro com "ver detalhes" + "tentar de novo"** → estado `error` do wizard (Task 3). ✓
- **Testes puros no smoke; spawn/UI por smoke manual** → Task 1 (auto) + Tasks 2/4 (manual). ✓
- **Ganchos futuros (quiz, skills, Supabase)** → fora do v1; nenhuma tarefa (correto). ✓

Consistência de tipos: `commandFor`/`isScaffoldable`/`junkPresent`/`mergePlan`/`listStacks` usados no Task 2 batem com as assinaturas do Task 1. Eventos `scaffold:progress|done|error` e handlers `scaffold:probe|run|status|stacks` batem entre Task 2 (produz) e Task 3/4 (consome). `startPreview` já existe no preload (linha 203).

Sem placeholders: todo passo tem código/comando real e saída esperada.
