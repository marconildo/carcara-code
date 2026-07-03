# SSH Remote Terminal (Camada 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir cadastrar um "projeto remoto (SSH)" no Carcará e rodar o terminal (sessão do Claude + shell livre) num VPS via `ssh2`, reaproveitando a máquina de terminal existente.

**Architecture:** Costura de transporte no main process — a interface `SessionTransport { write, resize, onData, onExit, kill }` tem duas implementações, `LocalPty` (embrulha o `node-pty` atual, comportamento intacto) e `SshShell` (canal de shell sobre um `Client` do `ssh2`). Os handlers `term:ensure`/`shell:ensure` bifurcam por `isRemote(projectPath)` (prefixo `ssh://`). Uma conexão `ssh2` por host é reusada entre canais.

**Tech Stack:** Electron (main CJS + preload), React 19 (renderer), `ssh2` (novo), `node-pty` (existente), `safeStorage` do Electron, Vitest.

## Global Constraints

- **Módulos do main são CJS** (`.cjs` ou `require`), como `claude-sessions.cjs`. O renderer é ESM (`import`).
- **Nunca gravar segredo em texto puro.** Senha/passphrase só via `safeStorage`; se indisponível, não persistir.
- **Caminho local não pode mudar de comportamento** — a extração do `LocalPty` é refactor puro.
- **Edições em `src/` só aparecem após `npm run build`** (o app carrega de `dist/`). Não forçar relaunch do app sem confirmar.
- **Chave do projeto remoto:** `ssh://user@host:porta/caminho/remoto`, usada como `projectPath` em toda a máquina existente. `hostKey` = `user@host:porta`.
- **Testes:** `npm test` roda `vitest run`. Testes de módulo do main ficam ao lado do arquivo (`remote/*.test.js`) e usam ESM `import` (o Vitest transpila); os módulos são CJS com `module.exports`, importáveis via `import x from './x.cjs'`.
- **`safeStorage` e `ssh2` não existem no ambiente Vitest** (sem Electron/rede) — módulos que dependem deles recebem as dependências por injeção (factory) para permitir fakes nos testes.
- **Commits frequentes**, mensagem em português seguindo o estilo do repo (`feat:`/`refactor:`/`test:`).

---

## File Structure

**Novos (main, CJS) — pasta `remote/`:**
- `remote/sshUri.cjs` — parse/build da URI `ssh://`, `isRemote`, `hostKey`. Puro.
- `remote/sshConfig.cjs` — parser do `~/.ssh/config`. Puro.
- `remote/secretStore.cjs` — factory de armazenamento de segredos (crypto injetável).
- `remote/knownHosts.cjs` — factory TOFU de host keys.
- `remote/localPty.cjs` — `LocalPty` (embrulho do `node-pty`).
- `remote/sshShell.cjs` — `SshShell` (canal de shell sobre um `Client`).
- `remote/connections.cjs` — factory do gerenciador de conexões `ssh2`.

**Modificados (main):**
- `main.js` — plumbing de `remotes` no config; handlers `remotes:*`/`projects:addRemote`/`ssh:configHosts`/`remote:test`; `projects:list` inclui remotos; bifurcação em `term:ensure`/`shell:ensure`; `projects:remove` encerra conexão.
- `preload.js` — expõe as APIs remotas + eventos de status.

**Modificados/novos (renderer, ESM):**
- `src/components/RemoteProjectModal.jsx` — formulário de cadastro/import/teste (novo).
- `src/components/Rail.jsx` — menu "adicionar" (local vs remoto) + selo/status remoto.
- `src/App.jsx` — fiação do modal, eventos de status e reconexão.
- `src/components/ShellView.jsx` — botão "Reconectar" inline no evento de queda.

**Dependência nova:** `ssh2` em `dependencies`.

---

## Task 0: Instalar `ssh2`

**Files:**
- Modify: `package.json` (dependencies)

- [ ] **Step 1: Instalar a lib**

Run: `npm install ssh2@^1.16.0`
Expected: `package.json` ganha `"ssh2": "^1.16.0"` em `dependencies`; instala sem erro de build nativo (é pure-JS + opcional cpu-features, que falha silencioso e não é obrigatório).

- [ ] **Step 2: Confirmar require**

Run: `node -e "require('ssh2'); console.log('ok')"`
Expected: imprime `ok`.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: adiciona ssh2 (Camada 1 SSH remoto)"
```

---

## Task 1: `remote/sshUri.cjs` — parse/build da URI e detecção de remoto

**Files:**
- Create: `remote/sshUri.cjs`
- Test: `remote/sshUri.test.js`

**Interfaces:**
- Produces:
  - `isRemote(projectPath: string): boolean` — `true` se começa com `ssh://`.
  - `parseSshUri(uri: string): { user, host, port, remoteDir } | null`
  - `buildSshUri({ user, host, port, remoteDir }): string`
  - `hostKey(uri: string): string` — `user@host:port` (sem o caminho).

- [ ] **Step 1: Write the failing test**

```js
// remote/sshUri.test.js
import { describe, it, expect } from 'vitest';
import { isRemote, parseSshUri, buildSshUri, hostKey } from './sshUri.cjs';

describe('isRemote', () => {
  it('detecta ssh:// e ignora caminhos locais', () => {
    expect(isRemote('ssh://ygor@1.2.3.4:22/home/ygor/app')).toBe(true);
    expect(isRemote('C:\\Users\\x\\proj')).toBe(false);
    expect(isRemote('/home/ygor/app')).toBe(false);
    expect(isRemote(null)).toBe(false);
  });
});

describe('parseSshUri', () => {
  it('separa user/host/port/dir', () => {
    expect(parseSshUri('ssh://ygor@1.2.3.4:2222/home/ygor/app')).toEqual({
      user: 'ygor', host: '1.2.3.4', port: 2222, remoteDir: '/home/ygor/app',
    });
  });
  it('assume porta 22 quando ausente', () => {
    expect(parseSshUri('ssh://ygor@host/srv/app')).toEqual({
      user: 'ygor', host: 'host', port: 22, remoteDir: '/srv/app',
    });
  });
  it('devolve null pra entrada inválida', () => {
    expect(parseSshUri('/local/path')).toBe(null);
  });
});

describe('buildSshUri + hostKey', () => {
  it('reconstrói a URI e extrai o hostKey', () => {
    const uri = buildSshUri({ user: 'ygor', host: '1.2.3.4', port: 2222, remoteDir: '/srv/app' });
    expect(uri).toBe('ssh://ygor@1.2.3.4:2222/srv/app');
    expect(hostKey(uri)).toBe('ygor@1.2.3.4:2222');
  });
  it('normaliza remoteDir sem barra inicial', () => {
    expect(buildSshUri({ user: 'a', host: 'h', port: 22, remoteDir: 'srv/app' }))
      .toBe('ssh://a@h:22/srv/app');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run remote/sshUri.test.js`
Expected: FAIL — `Failed to resolve import './sshUri.cjs'`.

- [ ] **Step 3: Write minimal implementation**

```js
// remote/sshUri.cjs
'use strict';

function isRemote(projectPath) {
  return typeof projectPath === 'string' && projectPath.startsWith('ssh://');
}

// ssh://user@host[:port]/remote/dir
function parseSshUri(uri) {
  if (!isRemote(uri)) return null;
  const m = /^ssh:\/\/([^@]+)@([^:/]+)(?::(\d+))?(\/.*)?$/.exec(uri);
  if (!m) return null;
  return {
    user: m[1],
    host: m[2],
    port: m[3] ? parseInt(m[3], 10) : 22,
    remoteDir: m[4] || '/',
  };
}

function buildSshUri({ user, host, port, remoteDir }) {
  const p = port || 22;
  let dir = remoteDir || '/';
  if (!dir.startsWith('/')) dir = '/' + dir;
  return `ssh://${user}@${host}:${p}${dir}`;
}

function hostKey(uri) {
  const p = parseSshUri(uri);
  return p ? `${p.user}@${p.host}:${p.port}` : '';
}

module.exports = { isRemote, parseSshUri, buildSshUri, hostKey };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run remote/sshUri.test.js`
Expected: PASS (todos os casos).

- [ ] **Step 5: Commit**

```bash
git add remote/sshUri.cjs remote/sshUri.test.js
git commit -m "feat: parser da URI ssh:// (Camada 1)"
```

---

## Task 2: `remote/sshConfig.cjs` — parser do `~/.ssh/config`

**Files:**
- Create: `remote/sshConfig.cjs`
- Test: `remote/sshConfig.test.js`

**Interfaces:**
- Produces:
  - `parseSshConfig(text: string): Array<{ host, hostName, user, port, identityFile }>` — um item por bloco `Host` (ignora curingas `*`).

- [ ] **Step 1: Write the failing test**

```js
// remote/sshConfig.test.js
import { describe, it, expect } from 'vitest';
import { parseSshConfig } from './sshConfig.cjs';

const SAMPLE = `
Host meuvps
  HostName 203.0.113.10
  User ygor
  Port 2222
  IdentityFile ~/.ssh/id_ed25519

Host *
  ServerAliveInterval 60

Host outro
  HostName example.com
`;

describe('parseSshConfig', () => {
  it('extrai blocos Host com seus campos', () => {
    const hosts = parseSshConfig(SAMPLE);
    expect(hosts).toEqual([
      { host: 'meuvps', hostName: '203.0.113.10', user: 'ygor', port: 2222, identityFile: '~/.ssh/id_ed25519' },
      { host: 'outro', hostName: 'example.com', user: null, port: null, identityFile: null },
    ]);
  });
  it('ignora curingas e devolve [] pra texto vazio', () => {
    expect(parseSshConfig('')).toEqual([]);
    expect(parseSshConfig('Host *\n  User x')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run remote/sshConfig.test.js`
Expected: FAIL — import não resolve.

- [ ] **Step 3: Write minimal implementation**

```js
// remote/sshConfig.cjs
'use strict';

function parseSshConfig(text) {
  const hosts = [];
  let cur = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const sp = line.indexOf(' ');
    const key = (sp === -1 ? line : line.slice(0, sp)).toLowerCase();
    const val = sp === -1 ? '' : line.slice(sp + 1).trim();
    if (key === 'host') {
      if (cur) hosts.push(cur);
      cur = val.includes('*') ? null
        : { host: val, hostName: null, user: null, port: null, identityFile: null };
    } else if (cur) {
      if (key === 'hostname') cur.hostName = val;
      else if (key === 'user') cur.user = val;
      else if (key === 'port') cur.port = parseInt(val, 10) || null;
      else if (key === 'identityfile') cur.identityFile = val;
    }
  }
  if (cur) hosts.push(cur);
  return hosts;
}

module.exports = { parseSshConfig };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run remote/sshConfig.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add remote/sshConfig.cjs remote/sshConfig.test.js
git commit -m "feat: parser do ~/.ssh/config (Camada 1)"
```

---

## Task 3: `remote/secretStore.cjs` — segredos via crypto injetável

**Files:**
- Create: `remote/secretStore.cjs`
- Test: `remote/secretStore.test.js`

**Interfaces:**
- Consumes: um objeto `crypto` com `{ isEncryptionAvailable(): boolean, encryptString(s): Buffer, decryptString(buf): string }` (em produção é o `safeStorage` do Electron) e um `filePath`.
- Produces: `makeSecretStore({ crypto, filePath }): { available(), save(hostKey, secret), load(hostKey), remove(hostKey) }`. `save` retorna `false` se indisponível (não persiste).

- [ ] **Step 1: Write the failing test**

```js
// remote/secretStore.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { makeSecretStore } from './secretStore.cjs';

// Fake do safeStorage: "cifra" com base64 (só pra testar o round-trip/persistência).
const fakeCrypto = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from('enc:' + s, 'utf8'),
  decryptString: (buf) => buf.toString('utf8').replace(/^enc:/, ''),
};
const unavailable = { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' };

let filePath;
beforeEach(() => {
  filePath = path.join(os.tmpdir(), `carcara-secrets-${process.pid}-${Math.round(performance.now())}.json`);
  try { fs.unlinkSync(filePath); } catch {}
});

describe('makeSecretStore', () => {
  it('round-trip cifra e recupera por hostKey', () => {
    const s = makeSecretStore({ crypto: fakeCrypto, filePath });
    expect(s.save('ygor@h:22', 'senha123')).toBe(true);
    const s2 = makeSecretStore({ crypto: fakeCrypto, filePath }); // relê do disco
    expect(s2.load('ygor@h:22')).toBe('senha123');
  });
  it('remove apaga o segredo', () => {
    const s = makeSecretStore({ crypto: fakeCrypto, filePath });
    s.save('a@h:22', 'x'); s.remove('a@h:22');
    expect(s.load('a@h:22')).toBe(null);
  });
  it('não persiste quando crypto indisponível', () => {
    const s = makeSecretStore({ crypto: unavailable, filePath });
    expect(s.available()).toBe(false);
    expect(s.save('a@h:22', 'x')).toBe(false);
    expect(fs.existsSync(filePath)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run remote/secretStore.test.js`
Expected: FAIL — import não resolve.

- [ ] **Step 3: Write minimal implementation**

```js
// remote/secretStore.cjs
'use strict';
const fs = require('fs');

// Persiste { [hostKey]: base64(cifra) } num arquivo. `crypto` é o safeStorage do
// Electron em produção (injetado pra ser testável sem Electron).
function makeSecretStore({ crypto, filePath }) {
  function readAll() {
    try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return {}; }
  }
  function writeAll(obj) {
    try { fs.writeFileSync(filePath, JSON.stringify(obj)); } catch {}
  }
  const available = () => {
    try { return !!crypto.isEncryptionAvailable(); } catch { return false; }
  };
  return {
    available,
    save(hostKey, secret) {
      if (!available()) return false;
      const all = readAll();
      all[hostKey] = crypto.encryptString(secret).toString('base64');
      writeAll(all);
      return true;
    },
    load(hostKey) {
      if (!available()) return null;
      const all = readAll();
      if (!all[hostKey]) return null;
      try { return crypto.decryptString(Buffer.from(all[hostKey], 'base64')); }
      catch { return null; }
    },
    remove(hostKey) {
      const all = readAll();
      if (all[hostKey]) { delete all[hostKey]; writeAll(all); }
    },
  };
}

module.exports = { makeSecretStore };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run remote/secretStore.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add remote/secretStore.cjs remote/secretStore.test.js
git commit -m "feat: cofre de segredos SSH via safeStorage (Camada 1)"
```

---

## Task 4: `remote/knownHosts.cjs` — TOFU de host keys

**Files:**
- Create: `remote/knownHosts.cjs`
- Test: `remote/knownHosts.test.js`

**Interfaces:**
- Consumes: `filePath` (JSON `{ [hostKey]: fingerprint }`).
- Produces: `makeKnownHosts({ filePath }): { fingerprint(keyBuf), check(hostKey, keyBuf), trust(hostKey, keyBuf) }`.
  - `fingerprint(buf): string` — `SHA256:<base64>`.
  - `check(hostKey, buf): 'trusted' | 'unknown' | 'changed'`.
  - `trust(hostKey, buf): void` — grava a fingerprint atual.

- [ ] **Step 1: Write the failing test**

```js
// remote/knownHosts.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { makeKnownHosts } from './knownHosts.cjs';

let filePath;
beforeEach(() => {
  filePath = path.join(os.tmpdir(), `carcara-kh-${process.pid}-${Math.round(performance.now())}.json`);
  try { fs.unlinkSync(filePath); } catch {}
});

describe('makeKnownHosts', () => {
  it('unknown → trust → trusted; chave diferente → changed', () => {
    const kh = makeKnownHosts({ filePath });
    const keyA = Buffer.from('chave-A');
    const keyB = Buffer.from('chave-B');
    expect(kh.check('h:22', keyA)).toBe('unknown');
    kh.trust('h:22', keyA);
    expect(kh.check('h:22', keyA)).toBe('trusted');
    expect(kh.check('h:22', keyB)).toBe('changed');
  });
  it('fingerprint é estável e prefixada', () => {
    const kh = makeKnownHosts({ filePath });
    const fp = kh.fingerprint(Buffer.from('x'));
    expect(fp).toMatch(/^SHA256:/);
    expect(kh.fingerprint(Buffer.from('x'))).toBe(fp);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run remote/knownHosts.test.js`
Expected: FAIL — import não resolve.

- [ ] **Step 3: Write minimal implementation**

```js
// remote/knownHosts.cjs
'use strict';
const fs = require('fs');
const crypto = require('crypto');

function makeKnownHosts({ filePath }) {
  function readAll() {
    try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return {}; }
  }
  function writeAll(obj) {
    try { fs.writeFileSync(filePath, JSON.stringify(obj)); } catch {}
  }
  const fingerprint = (keyBuf) =>
    'SHA256:' + crypto.createHash('sha256').update(keyBuf).digest('base64');
  return {
    fingerprint,
    check(hostKey, keyBuf) {
      const saved = readAll()[hostKey];
      if (!saved) return 'unknown';
      return saved === fingerprint(keyBuf) ? 'trusted' : 'changed';
    },
    trust(hostKey, keyBuf) {
      const all = readAll();
      all[hostKey] = fingerprint(keyBuf);
      writeAll(all);
    },
  };
}

module.exports = { makeKnownHosts };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run remote/knownHosts.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add remote/knownHosts.cjs remote/knownHosts.test.js
git commit -m "feat: known_hosts TOFU pro SSH remoto (Camada 1)"
```

---

## Task 5: `remote/localPty.cjs` — extrair o `node-pty` sem mudar comportamento

**Files:**
- Create: `remote/localPty.cjs`
- Test: `remote/localPty.test.js`
- Modify: `main.js` (usar `LocalPty` nos dois handlers de spawn)

**Interfaces:**
- Consumes: um `ptyLib` (o módulo `node-pty`, injetado) e `{ shell, env, cwd, cols, rows }`.
- Produces: `class LocalPty` implementando o contrato de transporte: `write(data)`, `resize(cols, rows)`, `onData(cb)`, `onExit(cb)`, `kill()`.

- [ ] **Step 1: Write the failing test (com node-pty fake)**

```js
// remote/localPty.test.js
import { describe, it, expect, vi } from 'vitest';
import { LocalPty } from './localPty.cjs';

function fakePtyLib() {
  const proc = {
    _data: null, _exit: null,
    onData(cb) { this._data = cb; }, onExit(cb) { this._exit = cb; },
    write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
  };
  return { lib: { spawn: vi.fn(() => proc) }, proc };
}

describe('LocalPty', () => {
  it('spawna com shell/cwd/env e repassa o contrato', () => {
    const { lib, proc } = fakePtyLib();
    const t = new LocalPty({ ptyLib: lib, shell: 'bash', env: { A: '1' }, cwd: '/x', cols: 80, rows: 24 });
    expect(lib.spawn).toHaveBeenCalledWith('bash', [], expect.objectContaining({ cwd: '/x', cols: 80, rows: 24, env: { A: '1' } }));

    const got = [];
    t.onData((d) => got.push(d));
    proc._data('oi');
    expect(got).toEqual(['oi']);

    t.write('ls\r'); expect(proc.write).toHaveBeenCalledWith('ls\r');
    t.resize(100, 30); expect(proc.resize).toHaveBeenCalledWith(100, 30);
    t.kill(); expect(proc.kill).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run remote/localPty.test.js`
Expected: FAIL — import não resolve.

- [ ] **Step 3: Write minimal implementation**

```js
// remote/localPty.cjs
'use strict';

// Embrulha o node-pty no contrato SessionTransport. Comportamento idêntico ao
// pty.spawn que existia inline no main.js.
class LocalPty {
  constructor({ ptyLib, shell, env, cwd, cols, rows }) {
    this.proc = ptyLib.spawn(shell, [], {
      name: 'xterm-256color',
      cols: cols || 80,
      rows: rows || 24,
      cwd,
      env,
    });
  }
  write(data) { this.proc.write(data); }
  resize(cols, rows) { try { this.proc.resize(cols, rows); } catch {} }
  onData(cb) { this.proc.onData(cb); }
  onExit(cb) { this.proc.onExit(cb); }
  kill() { try { this.proc.kill(); } catch {} }
}

module.exports = { LocalPty };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run remote/localPty.test.js`
Expected: PASS.

- [ ] **Step 5: Trocar o spawn inline no `main.js` por `LocalPty` (refactor)**

No topo do `main.js`, perto dos outros `require`, adicione:

```js
const { LocalPty } = require('./remote/localPty.cjs');
```

Em `term:ensure` ([main.js:1481](../../../main.js#L1481)), substitua o bloco:

```js
  const proc = pty.spawn(shellForOS(), [], {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: projectPath,
    env: cleanEnv(),
  });
```

por:

```js
  const proc = new LocalPty({ ptyLib: pty, shell: shellForOS(), env: cleanEnv(), cwd: projectPath, cols, rows });
```

Faça a mesma troca em `shell:ensure` ([main.js:1549](../../../main.js#L1549)). O restante (`entry.pty = proc`, `proc.onData`, `proc.onExit`, `proc.write`, `e.pty.resize`, `e.pty.kill`) já casa com o contrato do `LocalPty` — não mude.

- [ ] **Step 6: Build e verificação manual do terminal local**

Run: `npm run build`
Expected: build sem erro.

Rode o app (confirme antes que não há sessão viva) e abra um terminal local: o `claude` sobe e o shell livre funciona como antes. Rode a suíte:

Run: `npm test`
Expected: PASS (incluindo `localPty.test.js`).

- [ ] **Step 7: Commit**

```bash
git add remote/localPty.cjs remote/localPty.test.js main.js
git commit -m "refactor: extrai LocalPty do node-pty inline (Camada 1)"
```

---

## Task 6: `remote/sshShell.cjs` — canal de shell sobre um `Client`

**Files:**
- Create: `remote/sshShell.cjs`
- Test: `remote/sshShell.test.js`

**Interfaces:**
- Consumes: um `Client` do `ssh2` já conectado (com `.shell(opts, cb)`), e `{ cols, rows, remoteDir }`.
- Produces: `class SshShell` implementando o contrato: `write`, `resize`, `onData`, `onExit`, `kill`. Antes do canal abrir, `write` é bufferizado; ao abrir, faz `cd <remoteDir>` e descarrega o buffer.

- [ ] **Step 1: Write the failing test (com Client/stream fake)**

```js
// remote/sshShell.test.js
import { describe, it, expect, vi } from 'vitest';
import { SshShell } from './sshShell.cjs';

function fakeStream() {
  const handlers = {};
  return {
    on(ev, cb) { handlers[ev] = cb; return this; },
    write: vi.fn(),
    setWindow: vi.fn(),
    end: vi.fn(),
    _emit(ev, ...a) { handlers[ev] && handlers[ev](...a); },
  };
}

describe('SshShell', () => {
  it('abre shell, faz cd no remoteDir e repassa data', () => {
    const stream = fakeStream();
    const client = { shell: vi.fn((opts, cb) => cb(null, stream)) };
    const t = new SshShell(client, { cols: 80, rows: 24, remoteDir: '/srv/app' });

    expect(client.shell).toHaveBeenCalledWith(
      expect.objectContaining({ term: 'xterm-256color', cols: 80, rows: 24 }),
      expect.any(Function),
    );
    // cd inicial no diretório do projeto
    expect(stream.write).toHaveBeenCalledWith("cd '/srv/app'\n");

    const got = [];
    t.onData((d) => got.push(d));
    stream._emit('data', Buffer.from('remoto'));
    expect(got).toEqual(['remoto']);
  });

  it('bufferiza writes até o canal abrir', () => {
    let openCb;
    const stream = fakeStream();
    const client = { shell: vi.fn((opts, cb) => { openCb = () => cb(null, stream); }) };
    const t = new SshShell(client, { cols: 80, rows: 24, remoteDir: '/' });
    t.write('echo oi\r');           // canal ainda não abriu
    expect(stream.write).not.toHaveBeenCalledWith('echo oi\r');
    openCb();                        // agora abre
    expect(stream.write).toHaveBeenCalledWith('echo oi\r');
  });

  it('resize chama setWindow(rows, cols) e onExit dispara no close', () => {
    const stream = fakeStream();
    const client = { shell: (opts, cb) => cb(null, stream) };
    const t = new SshShell(client, { cols: 80, rows: 24, remoteDir: '/' });
    t.resize(120, 40);
    expect(stream.setWindow).toHaveBeenCalledWith(40, 120, 0, 0);
    const exit = vi.fn();
    t.onExit(exit);
    stream._emit('close');
    expect(exit).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run remote/sshShell.test.js`
Expected: FAIL — import não resolve.

- [ ] **Step 3: Write minimal implementation**

```js
// remote/sshShell.cjs
'use strict';

// Escapa um caminho pra uso entre aspas simples no shell POSIX.
function shq(p) { return "'" + String(p).replace(/'/g, "'\\''") + "'"; }

// Embrulha um canal de shell do ssh2 no contrato SessionTransport.
class SshShell {
  constructor(client, { cols, rows, remoteDir }) {
    this.stream = null;
    this.pending = [];         // writes antes do canal abrir
    this._dataCb = null;
    this._exitCb = null;
    this._lastSize = { cols: cols || 80, rows: rows || 24 };
    client.shell(
      { term: 'xterm-256color', cols: cols || 80, rows: rows || 24 },
      (err, stream) => {
        if (err) { if (this._exitCb) this._exitCb({ error: err.message }); return; }
        this.stream = stream;
        stream.on('data', (d) => { if (this._dataCb) this._dataCb(d.toString('utf8')); });
        stream.on('close', () => { if (this._exitCb) this._exitCb(); });
        if (remoteDir && remoteDir !== '/') stream.write('cd ' + shq(remoteDir) + '\n');
        for (const d of this.pending) stream.write(d);
        this.pending = [];
      },
    );
  }
  write(data) { if (this.stream) this.stream.write(data); else this.pending.push(data); }
  resize(cols, rows) {
    this._lastSize = { cols, rows };
    if (this.stream) { try { this.stream.setWindow(rows, cols, 0, 0); } catch {} }
  }
  onData(cb) { this._dataCb = cb; }
  onExit(cb) { this._exitCb = cb; }
  kill() { if (this.stream) { try { this.stream.end(); } catch {} } }
}

module.exports = { SshShell };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run remote/sshShell.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add remote/sshShell.cjs remote/sshShell.test.js
git commit -m "feat: SshShell (canal de shell ssh2) no contrato de transporte (Camada 1)"
```

---

## Task 7: `remote/connections.cjs` — gerenciador de conexões `ssh2`

**Files:**
- Create: `remote/connections.cjs`
- Test: `remote/connections.test.js`

**Interfaces:**
- Consumes (injetados):
  - `Client` — construtor do `ssh2` (`new Client()` com `.connect`, `.on`, `.end`).
  - `getProfile(hostKey): { host, port, user, authType, keyPath, remoteDir } | null` — perfil salvo (do config).
  - `getSecret(hostKey): string | null` — senha/passphrase decifrada.
  - `readKey(keyPath): Buffer` — lê o arquivo de chave privada.
  - `knownHosts` — o objeto do Task 4.
  - `confirmHostKey(hostKey, fingerprint, status): Promise<boolean>` — UI de confirmação TOFU (status `'unknown'`/`'changed'`).
  - `onStatus(hostKey, status): void` — callback de status (`'connecting'|'connected'|'disconnected'|'error'`).
  - `agentFor(): string` — retorna o socket do ssh-agent (`SSH_AUTH_SOCK`) ou `'pageant'` no Windows.
- Produces: `makeConnections(deps): { connFor(hostKey): Promise<Client>, status(hostKey): string, reconnect(hostKey): Promise<Client>, end(hostKey), endAll() }`. `connFor` devolve a conexão em cache se já `connected`.

- [ ] **Step 1: Write the failing test (Client fake orientado a eventos)**

```js
// remote/connections.test.js
import { describe, it, expect, vi } from 'vitest';
import { makeConnections } from './connections.cjs';

function fakeClient() {
  const h = {};
  return {
    on(ev, cb) { h[ev] = cb; return this; },
    connect: vi.fn(function (cfg) { this._cfg = cfg; }),
    end: vi.fn(),
    _ready() { h.ready && h.ready(); },
    _error(e) { h.error && h.error(e); },
    _close() { h.close && h.close(); },
    _cfg: null,
  };
}

const baseDeps = (client) => ({
  Client: vi.fn(() => client),
  getProfile: () => ({ host: 'h', port: 22, user: 'ygor', authType: 'password', keyPath: '', remoteDir: '/srv' }),
  getSecret: () => 'senha',
  readKey: () => Buffer.from('KEY'),
  knownHosts: { check: () => 'trusted', trust: vi.fn(), fingerprint: () => 'SHA256:x' },
  confirmHostKey: vi.fn(async () => true),
  onStatus: vi.fn(),
  agentFor: () => '/tmp/agent.sock',
});

describe('makeConnections', () => {
  it('conecta com senha e emite connecting→connected', async () => {
    const client = fakeClient();
    const deps = baseDeps(client);
    const conns = makeConnections(deps);
    const p = conns.connFor('ygor@h:22');
    expect(deps.onStatus).toHaveBeenCalledWith('ygor@h:22', 'connecting');
    expect(client.connect).toHaveBeenCalled();
    expect(client._cfg).toMatchObject({ host: 'h', port: 22, username: 'ygor', password: 'senha' });
    client._ready();
    await expect(p).resolves.toBe(client);
    expect(deps.onStatus).toHaveBeenCalledWith('ygor@h:22', 'connected');
  });

  it('reusa a conexão já conectada', async () => {
    const client = fakeClient();
    const deps = baseDeps(client);
    const conns = makeConnections(deps);
    const p = conns.connFor('ygor@h:22'); client._ready(); await p;
    const again = await conns.connFor('ygor@h:22');
    expect(again).toBe(client);
    expect(deps.Client).toHaveBeenCalledTimes(1); // não recriou
  });

  it('rejeita quando a autenticação falha', async () => {
    const client = fakeClient();
    const deps = baseDeps(client);
    const conns = makeConnections(deps);
    const p = conns.connFor('ygor@h:22');
    client._error(new Error('All authentication methods failed'));
    await expect(p).rejects.toThrow(/authentication/i);
    expect(deps.onStatus).toHaveBeenCalledWith('ygor@h:22', 'error');
  });

  it('monta auth por chave quando authType=key', async () => {
    const client = fakeClient();
    const deps = { ...baseDeps(client),
      getProfile: () => ({ host: 'h', port: 22, user: 'ygor', authType: 'key', keyPath: '/k/id', remoteDir: '/' }),
      getSecret: () => 'frase' };
    const conns = makeConnections(deps);
    const p = conns.connFor('ygor@h:22'); client._ready(); await p;
    expect(client._cfg).toMatchObject({ privateKey: Buffer.from('KEY'), passphrase: 'frase' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run remote/connections.test.js`
Expected: FAIL — import não resolve.

- [ ] **Step 3: Write minimal implementation**

```js
// remote/connections.cjs
'use strict';

// Gerenciador de conexões ssh2, uma por hostKey, reusada entre canais.
function makeConnections(deps) {
  const {
    Client, getProfile, getSecret, readKey, knownHosts,
    confirmHostKey, onStatus, agentFor,
  } = deps;
  const conns = new Map(); // hostKey -> { client, status, endTimer }

  function buildConnectConfig(hostKey, profile) {
    const cfg = {
      host: profile.host,
      port: profile.port || 22,
      username: profile.user,
      keepaliveInterval: 15000,
      hostVerifier: (keyBuf, verify) => {
        const state = knownHosts.check(hostKey, keyBuf);
        if (state === 'trusted') return verify(true);
        Promise.resolve(confirmHostKey(hostKey, knownHosts.fingerprint(keyBuf), state))
          .then((ok) => { if (ok) knownHosts.trust(hostKey, keyBuf); verify(!!ok); })
          .catch(() => verify(false));
      },
    };
    if (profile.authType === 'key') {
      cfg.privateKey = readKey(profile.keyPath);
      const pass = getSecret(hostKey);
      if (pass) cfg.passphrase = pass;
    } else if (profile.authType === 'password') {
      cfg.password = getSecret(hostKey);
    } else if (profile.authType === 'agent') {
      cfg.agent = agentFor();
    }
    return cfg;
  }

  function connFor(hostKey) {
    const existing = conns.get(hostKey);
    if (existing && existing.status === 'connected') {
      if (existing.endTimer) { clearTimeout(existing.endTimer); existing.endTimer = null; }
      return Promise.resolve(existing.client);
    }
    const profile = getProfile(hostKey);
    if (!profile) return Promise.reject(new Error('Perfil remoto não encontrado: ' + hostKey));

    const client = new Client();
    const rec = { client, status: 'connecting', endTimer: null };
    conns.set(hostKey, rec);
    onStatus(hostKey, 'connecting');

    return new Promise((resolve, reject) => {
      let settled = false;
      client.on('ready', () => {
        rec.status = 'connected';
        onStatus(hostKey, 'connected');
        settled = true; resolve(client);
      });
      client.on('error', (err) => {
        rec.status = 'error';
        onStatus(hostKey, 'error');
        if (!settled) { settled = true; reject(err); }
      });
      client.on('close', () => {
        if (rec.status === 'connected') { rec.status = 'disconnected'; onStatus(hostKey, 'disconnected'); }
        conns.delete(hostKey);
      });
      try { client.connect(buildConnectConfig(hostKey, profile)); }
      catch (err) { if (!settled) { settled = true; reject(err); } }
    });
  }

  return {
    connFor,
    status: (hostKey) => (conns.get(hostKey) || {}).status || 'idle',
    reconnect(hostKey) { const r = conns.get(hostKey); if (r) { try { r.client.end(); } catch {} conns.delete(hostKey); } return connFor(hostKey); },
    end(hostKey) {
      const r = conns.get(hostKey);
      if (!r) return;
      r.endTimer = setTimeout(() => { try { r.client.end(); } catch {} conns.delete(hostKey); }, 3000);
    },
    endAll() { for (const [, r] of conns) { try { r.client.end(); } catch {} } conns.clear(); },
  };
}

module.exports = { makeConnections };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run remote/connections.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add remote/connections.cjs remote/connections.test.js
git commit -m "feat: gerenciador de conexões ssh2 (Camada 1)"
```

---

## Task 8: Plumbing de `remotes` no config + fiação dos módulos no `main.js`

**Files:**
- Modify: `main.js` (requires, instância do secretStore/knownHosts/connections, helpers de perfil)

**Interfaces:**
- Consumes: `makeSecretStore`, `makeKnownHosts`, `makeConnections`, `parseSshUri`, `hostKey`, `isRemote`.
- Produces (no escopo do main, usados nas próximas tasks):
  - `remoteProfile(hostKey): profile|null` — lê `cfg.remotes[hostKey]`.
  - a instância `connections` com `connFor`/`end`/`endAll`.

- [ ] **Step 1: Requires e instâncias**

No topo do `main.js` (perto do `require` do `LocalPty`), adicione:

```js
const { isRemote, parseSshUri, hostKey } = require('./remote/sshUri.cjs');
const { SshShell } = require('./remote/sshShell.cjs');
const { makeSecretStore } = require('./remote/secretStore.cjs');
const { makeKnownHosts } = require('./remote/knownHosts.cjs');
const { makeConnections } = require('./remote/connections.cjs');
const { Client: SshClient } = require('ssh2');
```

Depois de `app` estar pronto (dentro de `app.whenReady().then(...)`, onde `app.getPath('userData')` já resolve — procure o bloco de inicialização atual), instancie:

```js
const secretStore = makeSecretStore({
  crypto: safeStorage,
  filePath: path.join(app.getPath('userData'), 'remotes.secrets'),
});
const knownHosts = makeKnownHosts({
  filePath: path.join(app.getPath('userData'), 'known_hosts.json'),
});
const connections = makeConnections({
  Client: SshClient,
  getProfile: (hk) => remoteProfile(hk),
  getSecret: (hk) => secretStore.load(hk),
  readKey: (p) => fs.readFileSync(p),
  knownHosts,
  confirmHostKey: (hk, fp, state) => confirmHostKey(hk, fp, state),
  onStatus: (hk, status) => safeSend('remote:status', { hostKey: hk, status }),
  agentFor: () => (process.platform === 'win32' ? 'pageant' : process.env.SSH_AUTH_SOCK || ''),
});
```

Adicione `safeStorage` ao import do electron no topo (junto de `app`, `dialog`, etc.).

- [ ] **Step 2: Helpers de perfil e confirmação de host key**

Adicione perto dos helpers de config (após `saveConfig`):

```js
// Perfil de um projeto remoto, guardado em cfg.remotes[hostKey] (não-secreto).
function remoteProfile(hk) {
  const c = loadConfig();
  return (c.remotes && c.remotes[hk]) || null;
}

// Confirmação TOFU do host key via diálogo nativo. Retorna Promise<boolean>.
function confirmHostKey(hk, fingerprint, state) {
  const changed = state === 'changed';
  const title = changed ? 'Host key MUDOU' : 'Novo host SSH';
  const detail = changed
    ? `A identidade de ${hk} mudou (${fingerprint}). Pode ser um servidor recriado — ou um ataque. Confiar mesmo assim?`
    : `Primeira conexão com ${hk}.\nFingerprint: ${fingerprint}\nConfiar neste servidor?`;
  return dialog.showMessageBox(mainWindow, {
    type: changed ? 'warning' : 'question',
    buttons: ['Confiar', 'Cancelar'],
    defaultId: changed ? 1 : 0,
    cancelId: 1,
    title,
    message: title,
    detail,
  }).then((r) => r.response === 0);
}
```

- [ ] **Step 3: Encerrar conexões ao sair**

No handler de `window-all-closed`/`before-quit` do app (procure o existente), adicione:

```js
try { connections.endAll(); } catch {}
```

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: build sem erro (sem uso ainda de `SshShell`/`isRemote` — os `require` só precisam resolver).

- [ ] **Step 5: Commit**

```bash
git add main.js
git commit -m "feat: fia secretStore/knownHosts/connections no main (Camada 1)"
```

---

## Task 9: Handlers de config remota — `remotes:*`, `ssh:configHosts`, `remote:test`

**Files:**
- Modify: `main.js` (novos `ipcMain.handle`)
- Modify: `main.js` — `projects:list` inclui remotos e não filtra por `statSync`; `projects:remove` encerra conexão

**Interfaces:**
- Consumes: `buildSshUri`, `parseSshConfig`, `secretStore`, `connections`, `remoteProfile`.
- Produces (IPC): `remotes:add`, `remotes:remove` (via `projects:remove`), `ssh:configHosts`, `remote:test`.

- [ ] **Step 1: Handler `remotes:add` (salva perfil + segredo) → devolve a URI**

Adicione perto de `projects:add`:

```js
// Cadastra/atualiza um projeto remoto. profile: { host, port, user, authType,
// keyPath, remoteDir, label }. secret: senha ou passphrase (opcional).
ipcMain.handle('remotes:add', (evt, { profile, secret }) => {
  const port = parseInt(profile.port, 10) || 22;
  const uri = buildSshUri({ user: profile.user, host: profile.host, port, remoteDir: profile.remoteDir });
  const hk = hostKey(uri);
  const c = loadConfig();
  c.remotes = c.remotes || {};
  c.remotes[hk] = {
    host: profile.host, port, user: profile.user,
    authType: profile.authType, keyPath: profile.keyPath || '',
    remoteDir: profile.remoteDir || '/', label: profile.label || '',
  };
  if (!c.projects.includes(uri)) c.projects.push(uri);
  saveConfig(c);
  let secretSaved = true;
  if (secret && (profile.authType === 'password' || profile.authType === 'key')) {
    secretSaved = secretStore.save(hk, secret);
  }
  return { uri, hostKey: hk, secretSaved };
});
```

Adicione `buildSshUri` e `parseSshConfig` aos requires do topo:

```js
const { isRemote, parseSshUri, buildSshUri, hostKey } = require('./remote/sshUri.cjs');
const { parseSshConfig } = require('./remote/sshConfig.cjs');
```

(substitui a linha de require do sshUri do Task 8).

- [ ] **Step 2: Handler `ssh:configHosts` (importar do ~/.ssh/config)**

```js
ipcMain.handle('ssh:configHosts', () => {
  try {
    const txt = fs.readFileSync(path.join(os.homedir(), '.ssh', 'config'), 'utf8');
    return { hosts: parseSshConfig(txt) };
  } catch { return { hosts: [] }; }
});
```

- [ ] **Step 3: Handler `remote:test` (handshake rápido)**

```js
// Testa a conexão sem persistir: conecta, roda `pwd`, desconecta.
ipcMain.handle('remote:test', (evt, { profile, secret }) => new Promise((resolve) => {
  const conn = new SshClient();
  let done = false;
  const finish = (ok, message) => { if (done) return; done = true; try { conn.end(); } catch {} resolve({ ok, message }); };
  const cfg = {
    host: profile.host, port: parseInt(profile.port, 10) || 22, username: profile.user,
    readyTimeout: 10000,
    hostVerifier: () => true, // teste não persiste TOFU
  };
  if (profile.authType === 'key') { try { cfg.privateKey = fs.readFileSync(profile.keyPath); } catch (e) { return finish(false, 'Chave: ' + e.message); } if (secret) cfg.passphrase = secret; }
  else if (profile.authType === 'password') cfg.password = secret;
  else if (profile.authType === 'agent') cfg.agent = process.platform === 'win32' ? 'pageant' : process.env.SSH_AUTH_SOCK || '';
  conn.on('ready', () => conn.exec('pwd', (err, stream) => {
    if (err) return finish(false, err.message);
    let out = '';
    stream.on('data', (d) => { out += d.toString(); });
    stream.on('close', () => finish(true, 'Conectado — pwd: ' + out.trim()));
  }));
  conn.on('error', (err) => finish(false, err.message));
  try { conn.connect(cfg); } catch (e) { finish(false, e.message); }
}));
```

- [ ] **Step 4: `projects:list` inclui remotos**

Em `projects:list` ([main.js:629](../../../main.js#L629)), o `.filter((p) => { try { return fs.statSync(p).isDirectory(); ...})` descarta `ssh://`. Troque o `.filter(...).map(...)` para tratar remotos:

```js
  return cfg.projects
    .filter((p) => {
      if (isRemote(p)) return true;
      try { return fs.statSync(p).isDirectory(); } catch { return false; }
    })
    .map((p) => {
      if (isRemote(p)) {
        const hk = hostKey(p);
        const prof = (cfg.remotes && cfg.remotes[hk]) || {};
        const parsed = parseSshUri(p) || {};
        return {
          name: prof.label || `${parsed.user}@${parsed.host}`,
          path: p,
          hasPkg: false,
          running: false,
          icon: null,
          color: (cfg.projectMeta && cfg.projectMeta[p] && cfg.projectMeta[p].color) || null,
          remote: true,
          status: connections.status(hk),
        };
      }
      // ...bloco local existente permanece igual...
```

Mantenha o retorno local existente após o `if (isRemote(p))`. Para os projetos locais, acrescente `remote: false` no objeto retornado (pra o renderer distinguir).

- [ ] **Step 5: `projects:remove` encerra conexão e limpa segredo**

Em `projects:remove` ([main.js:555](../../../main.js#L555)), antes de `saveConfig(cfg)`, adicione:

```js
  if (isRemote(projectPath)) {
    const hk = hostKey(projectPath);
    try { connections.end(hk); } catch {}
    try { secretStore.remove(hk); } catch {}
    if (cfg.remotes) delete cfg.remotes[hk];
    // mata o shell remoto do projeto, se houver
    const sh = shells.get(projectPath);
    if (sh) { try { sh.pty.kill(); } catch {} shells.delete(projectPath); }
  }
```

- [ ] **Step 6: Build e sanidade**

Run: `npm run build && npm test`
Expected: build ok; testes existentes continuam PASS (nenhum teste novo aqui — é fiação IPC, verificada nas tasks de UI).

- [ ] **Step 7: Commit**

```bash
git add main.js
git commit -m "feat: handlers de projeto remoto (add/test/import) + lista inclui remotos (Camada 1)"
```

---

## Task 10: Bifurcação de transporte em `term:ensure` e `shell:ensure`

**Files:**
- Modify: `main.js` (`term:ensure`, `shell:ensure`)

**Interfaces:**
- Consumes: `isRemote`, `parseSshUri`, `hostKey`, `connections.connFor`, `SshShell`, `LocalPty`.

- [ ] **Step 1: Helper `makeTransport`**

Adicione perto de `shellForOS`:

```js
// Escolhe o transporte da sessão: node-pty local ou canal ssh2 remoto.
async function makeTransport(projectPath, cols, rows) {
  if (!isRemote(projectPath)) {
    const pty = ptyLib || (ptyLib = require('node-pty'));
    return new LocalPty({ ptyLib: pty, shell: shellForOS(), env: cleanEnv(), cwd: projectPath, cols, rows });
  }
  const hk = hostKey(projectPath);
  const client = await connections.connFor(hk); // pode lançar (auth/conexão)
  const { remoteDir } = parseSshUri(projectPath);
  return new SshShell(client, { cols, rows, remoteDir });
}
```

- [ ] **Step 2: `shell:ensure` remoto**

Torne o handler `async` e troque o `pty.spawn(...)` (agora `new LocalPty(...)` do Task 5) por `await makeTransport(...)`, com try/catch pro caso remoto:

```js
ipcMain.handle('shell:ensure', async (evt, { projectPath, cols, rows }) => {
  if (shells.has(projectPath)) {
    return { existed: true, buffer: shells.get(projectPath).buffer };
  }
  let proc;
  try {
    proc = await makeTransport(projectPath, cols, rows);
  } catch (e) {
    return { error: 'Conexão SSH falhou: ' + e.message };
  }
  const entry = { pty: proc, buffer: '' };
  shells.set(projectPath, entry);
  proc.onData((data) => {
    entry.buffer += data;
    if (entry.buffer.length > 200000) entry.buffer = entry.buffer.slice(-150000);
    safeSend('shell:data', { projectPath, data });
  });
  proc.onExit(() => {
    shells.delete(projectPath);
    safeSend('shell:exit', { projectPath });
  });
  return { existed: false, buffer: '' };
});
```

- [ ] **Step 3: `term:ensure` remoto (sessão do Claude)**

Torne o handler `async`. Substitua a criação do PTY por `await makeTransport(...)` e **pule** o watcher/tema quando remoto. O launch remoto sobe `claude` puro (resume/título remotos são Camada 4):

```js
ipcMain.handle('term:ensure', async (evt, { sessionId, projectPath, cols, rows, theme }) => {
  if (terminals.has(sessionId)) {
    return { existed: true, buffer: terminals.get(sessionId).buffer };
  }
  const remote = isRemote(projectPath);
  let proc;
  try {
    proc = await makeTransport(projectPath, cols, rows);
  } catch (e) {
    return { error: 'Conexão SSH falhou: ' + e.message };
  }
  const { cli } = remote ? { cli: 'claude' } : resolveProjectCli(projectPath);
  const entry = { pty: proc, buffer: '', projectPath, sessionId, cli, remote };
  terminals.set(sessionId, entry);

  proc.onData((data) => {
    entry.buffer += data;
    if (entry.buffer.length > 200000) entry.buffer = entry.buffer.slice(-150000);
    if (!remote) { captureResumeId(entry); activityOnData(entry, data); }
    safeSend('term:data', { sessionId, data });
  });
  proc.onExit(() => {
    if (entry.idleTimer) { clearTimeout(entry.idleTimer); entry.idleTimer = null; }
    if (entry.titleTimer) { clearInterval(entry.titleTimer); entry.titleTimer = null; }
    terminals.delete(sessionId);
    emitActivity(entry, 'idle');
    safeSend('term:exit', { sessionId });
  });

  if (remote) {
    // Camada 1: sobe o claude puro no VPS; título/resume remoto ficam pra Camada 4.
    proc.write('claude\r');
  } else {
    if (cli === 'claude' && theme) applyClaudeTheme(theme);
    const launch = buildLaunchCommand(sessionId, projectPath);
    if (cli === 'claude') {
      entry.claudeId = launch.claudeId || null;
      startClaudeWatcher(entry, launch.capture);
    }
    proc.write(launch.cmd + '\r');
  }
  return { existed: false, buffer: '' };
});
```

- [ ] **Step 4: Build e verificação de regressão local**

Run: `npm run build && npm test`
Expected: build ok; testes PASS. Rode o app e confirme que um **projeto local** ainda abre `claude` e shell normalmente (o caminho `remote=false` é idêntico ao anterior).

- [ ] **Step 5: Commit**

```bash
git add main.js
git commit -m "feat: term/shell:ensure bifurcam pra transporte SSH remoto (Camada 1)"
```

---

## Task 11: Expor APIs remotas no `preload.js`

**Files:**
- Modify: `preload.js`

**Interfaces:**
- Produces (no `window.api`): `addRemote`, `testRemote`, `sshConfigHosts`, `reconnectRemote`, e o evento `remote:status` já chega pelo `on` genérico existente.

- [ ] **Step 1: Adicionar métodos**

Perto do bloco `shellEnsure/shellInput/shellResize` ([preload.js:80](../../../preload.js#L80)), adicione:

```js
  addRemote: (profile, secret) => ipcRenderer.invoke('remotes:add', { profile, secret }),
  testRemote: (profile, secret) => ipcRenderer.invoke('remote:test', { profile, secret }),
  sshConfigHosts: () => ipcRenderer.invoke('ssh:configHosts'),
  reconnectRemote: (projectPath) => ipcRenderer.invoke('remote:reconnect', { projectPath }),
```

- [ ] **Step 2: Handler `remote:reconnect` no main**

Em `main.js`, perto dos outros handlers remotos:

```js
ipcMain.handle('remote:reconnect', async (evt, { projectPath }) => {
  if (!isRemote(projectPath)) return { ok: false };
  try { await connections.reconnect(hostKey(projectPath)); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});
```

- [ ] **Step 3: Confirmar que `window.api.on` já cobre eventos genéricos**

Verifique que `preload.js` já expõe um `on(channel, cb)` genérico (o `ShellView` usa `window.api.on('shell:data', ...)`). Se sim, `remote:status` chega por ele — nada a fazer. Se o `on` filtra por lista de canais, adicione `'remote:status'` à lista permitida.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: sem erro.

- [ ] **Step 5: Commit**

```bash
git add preload.js main.js
git commit -m "feat: expõe APIs de projeto remoto no preload (Camada 1)"
```

---

## Task 12: `RemoteProjectModal.jsx` — formulário de cadastro/import/teste

**Files:**
- Create: `src/components/RemoteProjectModal.jsx`
- Test: `src/components/remoteProfile.test.js` (validação pura extraída)
- Create: `src/lib/remoteProfile.js` (validação pura, testável)

**Interfaces:**
- Consumes: `window.api.addRemote`, `window.api.testRemote`, `window.api.sshConfigHosts`.
- Produces: `<RemoteProjectModal open onClose onAdded />` — ao salvar, chama `addRemote` e dispara `onAdded(uri)`.
  - `validateRemoteProfile(profile): { ok: boolean, error?: string }` (de `remoteProfile.js`).

- [ ] **Step 1: Write the failing test (validação pura)**

```js
// src/components/remoteProfile.test.js
import { describe, it, expect } from 'vitest';
import { validateRemoteProfile } from '@/lib/remoteProfile.js';

describe('validateRemoteProfile', () => {
  it('exige host e user', () => {
    expect(validateRemoteProfile({ host: '', user: 'x', authType: 'agent', remoteDir: '/a' }).ok).toBe(false);
    expect(validateRemoteProfile({ host: 'h', user: '', authType: 'agent', remoteDir: '/a' }).ok).toBe(false);
  });
  it('exige keyPath quando authType=key', () => {
    expect(validateRemoteProfile({ host: 'h', user: 'x', authType: 'key', keyPath: '', remoteDir: '/a' }).ok).toBe(false);
    expect(validateRemoteProfile({ host: 'h', user: 'x', authType: 'key', keyPath: '/k', remoteDir: '/a' }).ok).toBe(true);
  });
  it('aceita perfil válido com agent', () => {
    expect(validateRemoteProfile({ host: 'h', user: 'x', authType: 'agent', remoteDir: '/srv' }).ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/remoteProfile.test.js`
Expected: FAIL — import não resolve.

- [ ] **Step 3: Implementar a validação pura**

```js
// src/lib/remoteProfile.js
export function validateRemoteProfile(p) {
  if (!p || !p.host || !p.host.trim()) return { ok: false, error: 'Informe o host.' };
  if (!p.user || !p.user.trim()) return { ok: false, error: 'Informe o usuário.' };
  if (!p.remoteDir || !p.remoteDir.trim()) return { ok: false, error: 'Informe o diretório remoto.' };
  if (p.authType === 'key' && !(p.keyPath && p.keyPath.trim())) {
    return { ok: false, error: 'Informe o arquivo da chave privada.' };
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/remoteProfile.test.js`
Expected: PASS.

- [ ] **Step 5: Implementar o modal**

```jsx
// src/components/RemoteProjectModal.jsx
import { useState } from 'react';
import { validateRemoteProfile } from '@/lib/remoteProfile.js';

const EMPTY = { host: '', port: 22, user: '', authType: 'key', keyPath: '', remoteDir: '', label: '' };

export function RemoteProjectModal({ open, onClose, onAdded }) {
  const [p, setP] = useState(EMPTY);
  const [secret, setSecret] = useState('');
  const [test, setTest] = useState(null); // { ok, message }
  const [busy, setBusy] = useState(false);
  const [hosts, setHosts] = useState(null);
  if (!open) return null;
  const set = (k) => (e) => setP((v) => ({ ...v, [k]: e.target.value }));

  async function importConfig() {
    const { hosts } = await window.api.sshConfigHosts();
    setHosts(hosts);
  }
  function pickHost(h) {
    setP((v) => ({ ...v, host: h.hostName || h.host, user: h.user || v.user,
      port: h.port || 22, authType: h.identityFile ? 'key' : v.authType,
      keyPath: h.identityFile || v.keyPath, label: h.host }));
    setHosts(null);
  }
  async function doTest() {
    const v = validateRemoteProfile(p);
    if (!v.ok) { setTest({ ok: false, message: v.error }); return; }
    setBusy(true);
    setTest(await window.api.testRemote(p, secret));
    setBusy(false);
  }
  async function save() {
    const v = validateRemoteProfile(p);
    if (!v.ok) { setTest({ ok: false, message: v.error }); return; }
    setBusy(true);
    const res = await window.api.addRemote(p, secret);
    setBusy(false);
    onAdded?.(res.uri);
    onClose?.();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="w-[460px] rounded-xl border border-border bg-background p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-3 text-lg font-semibold">Novo projeto remoto (SSH)</h2>
        <button className="mb-3 text-sm text-primary underline" onClick={importConfig} disabled={busy}>Importar do ~/.ssh/config</button>
        {hosts && (
          <ul className="mb-3 max-h-32 overflow-auto rounded border border-border">
            {hosts.length === 0 && <li className="p-2 text-sm text-muted-foreground">Nenhum host encontrado.</li>}
            {hosts.map((h) => (
              <li key={h.host}><button className="w-full p-2 text-left text-sm hover:bg-muted" onClick={() => pickHost(h)}>{h.host} — {h.hostName || '?'}</button></li>
            ))}
          </ul>
        )}
        <div className="grid grid-cols-2 gap-2">
          <input className="col-span-2 rounded border border-border bg-background p-2 text-sm" placeholder="Host (ex.: 203.0.113.10)" value={p.host} onChange={set('host')} />
          <input className="rounded border border-border bg-background p-2 text-sm" placeholder="Usuário" value={p.user} onChange={set('user')} />
          <input className="rounded border border-border bg-background p-2 text-sm" placeholder="Porta" value={p.port} onChange={set('port')} />
          <select className="col-span-2 rounded border border-border bg-background p-2 text-sm" value={p.authType} onChange={set('authType')}>
            <option value="key">Chave privada (arquivo)</option>
            <option value="password">Senha</option>
            <option value="agent">ssh-agent</option>
          </select>
          {p.authType === 'key' && (
            <input className="col-span-2 rounded border border-border bg-background p-2 text-sm" placeholder="Caminho da chave (ex.: ~/.ssh/id_ed25519)" value={p.keyPath} onChange={set('keyPath')} />
          )}
          {(p.authType === 'password' || p.authType === 'key') && (
            <input type="password" className="col-span-2 rounded border border-border bg-background p-2 text-sm" placeholder={p.authType === 'key' ? 'Passphrase da chave (opcional)' : 'Senha'} value={secret} onChange={(e) => setSecret(e.target.value)} />
          )}
          <input className="col-span-2 rounded border border-border bg-background p-2 text-sm" placeholder="Diretório remoto (ex.: /home/ygor/app)" value={p.remoteDir} onChange={set('remoteDir')} />
          <input className="col-span-2 rounded border border-border bg-background p-2 text-sm" placeholder="Rótulo (opcional)" value={p.label} onChange={set('label')} />
        </div>
        {test && (
          <p className={`mt-2 text-sm ${test.ok ? 'text-green-600' : 'text-red-500'}`}>{test.ok ? '✓ ' : '✗ '}{test.message}</p>
        )}
        <div className="mt-4 flex justify-between">
          <button className="rounded border border-border px-3 py-1.5 text-sm" onClick={doTest} disabled={busy}>Testar conexão</button>
          <div className="flex gap-2">
            <button className="rounded border border-border px-3 py-1.5 text-sm" onClick={onClose} disabled={busy}>Cancelar</button>
            <button className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground" onClick={save} disabled={busy}>Salvar</button>
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Build**

Run: `npm run build`
Expected: sem erro (o modal ainda não é montado por ninguém — Task 13).

- [ ] **Step 7: Commit**

```bash
git add src/components/RemoteProjectModal.jsx src/lib/remoteProfile.js src/components/remoteProfile.test.js
git commit -m "feat: modal de cadastro de projeto remoto SSH (Camada 1)"
```

---

## Task 13: Rail — menu "adicionar" (local vs remoto) + status remoto

**Files:**
- Modify: `src/components/Rail.jsx`
- Modify: `src/App.jsx` (montar o modal, tratar `onAdded`, ouvir `remote:status`)

**Interfaces:**
- Consumes: `RemoteProjectModal`, `window.api.on('remote:status', cb)`, `projects[].remote`, `projects[].status`.

- [ ] **Step 1: App — estado do modal e recarga da lista**

Em `src/App.jsx`, onde hoje o `onAdd` chama `window.api.addProjects()` e recarrega a lista (procure a função que trata adicionar projeto), introduza um seletor. Adicione estado:

```jsx
const [remoteOpen, setRemoteOpen] = useState(false);
```

Modifique o handler de adicionar para abrir um menu simples. Onde `onAdd` é passado ao `<Rail>`, troque por dois callbacks:

```jsx
<Rail
  /* ...props existentes... */
  onAddLocal={async () => { await window.api.addProjects(); await reloadProjects(); }}
  onAddRemote={() => setRemoteOpen(true)}
/>
```

(`reloadProjects` é a função que já recarrega `projects:list` — reuse a existente; se o nome for outro, use o atual.)

Monte o modal no fim do JSX do `App`:

```jsx
<RemoteProjectModal
  open={remoteOpen}
  onClose={() => setRemoteOpen(false)}
  onAdded={async () => { await reloadProjects(); }}
/>
```

Importe no topo: `import { RemoteProjectModal } from '@/components/RemoteProjectModal.jsx';`

- [ ] **Step 2: App — ouvir status remoto e atualizar a lista**

No `useEffect` de listeners de IPC (onde já há `window.api.on('shell:exit', ...)` etc.), adicione:

```jsx
window.api.on('remote:status', () => { reloadProjects(); });
```

Isso reflete o ponto de status (a `projects:list` já devolve `status` via `connections.status`).

- [ ] **Step 3: Rail — botão de adicionar com duas opções**

Em `src/components/Rail.jsx`, a assinatura ganha `onAddLocal`/`onAddRemote` (substituindo/complementando `onAdd`). No botão "+" existente, troque o clique único por um pequeno menu. Exemplo mínimo com estado local:

```jsx
const [addMenu, setAddMenu] = useState(false);
// ...
<div className="relative">
  <button className="rail-add-btn" title="Adicionar projeto" onClick={() => setAddMenu((v) => !v)}>+</button>
  {addMenu && (
    <div className="absolute z-50 mt-1 rounded border border-border bg-background shadow" onMouseLeave={() => setAddMenu(false)}>
      <button className="block w-full px-3 py-1.5 text-left text-sm hover:bg-muted" onClick={() => { setAddMenu(false); onAddLocal?.(); }}>Pasta local…</button>
      <button className="block w-full px-3 py-1.5 text-left text-sm hover:bg-muted" onClick={() => { setAddMenu(false); onAddRemote?.(); }}>Remoto (SSH)…</button>
    </div>
  )}
</div>
```

(Se o Rail já tiver um componente de menu/portal próprio, use-o em vez desse div absoluto — siga o padrão do arquivo.)

- [ ] **Step 4: Rail — selo e ponto de status no ícone remoto**

Onde cada projeto é renderizado no Rail (o `map` sobre `display`), quando `p.remote`, sobreponha um ponto de status. Adicione dentro do container do ícone:

```jsx
{p.remote && (
  <span
    title={`SSH: ${p.status || 'idle'}`}
    className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-background"
    style={{ background: p.status === 'connected' ? '#16a34a' : p.status === 'connecting' ? '#f59e0b' : p.status === 'error' || p.status === 'disconnected' ? '#ef4444' : '#9ca3af' }}
  />
)}
```

(Âmbar/verde/vermelho — combina com a paleta "carvão + brasa"; nada de azul.)

- [ ] **Step 5: Build e verificação manual (fim-a-fim)**

Run: `npm run build`
Expected: sem erro.

Rode o app e verifique o fluxo completo contra um VPS real (ou um `sshd` local):
1. "+" → "Remoto (SSH)…" → preencher / importar do `~/.ssh/config` → "Testar conexão" mostra ✓.
2. "Salvar" cria o ícone no Rail com ponto de status.
3. Abrir o projeto: o terminal conecta (ponto fica verde), o shell livre roda comandos no VPS; a aba de sessão sobe `claude` no servidor.
4. Na 1ª conexão, o diálogo de host key aparece; "Confiar" prossegue.
5. Resize e copiar/colar funcionam.

- [ ] **Step 6: Commit**

```bash
git add src/components/Rail.jsx src/App.jsx
git commit -m "feat: adicionar projeto remoto pelo Rail + ponto de status (Camada 1)"
```

---

## Task 14: Reconexão inline no `ShellView` + `known_hosts` no gitignore de runtime

**Files:**
- Modify: `src/components/ShellView.jsx`
- Modify: `.gitignore` (garantir que segredos/known_hosts de runtime não vazem — eles vivem em `userData`, fora do repo, então normalmente nada a fazer; confirmar)

**Interfaces:**
- Consumes: `window.api.on('shell:exit', ...)` (já existe), `window.api.reconnectRemote`, `window.api.shellEnsure`.

- [ ] **Step 1: Botão "Reconectar" na queda**

Em `ShellView.jsx`, o listener `shell:exit` ([src/components/ShellView.jsx:77](../../../src/components/ShellView.jsx#L77)) hoje escreve `[sessão encerrada]`. Para projeto remoto, ofereça reconectar. Como o `ShellView` não sabe se é remoto, detecte pelo prefixo `ssh://` do `projectPath`:

```jsx
window.api.on('shell:exit', ({ projectPath }) => {
  const t = termsRef.current.get(projectPath);
  if (!t) return;
  if (projectPath.startsWith('ssh://')) {
    t.term.write('\r\n\x1b[90m[conexão perdida] — pressione Enter para reconectar\x1b[0m\r\n');
    t.awaitingReconnect = true;
  } else {
    t.term.write('\r\n\x1b[90m[sessão encerrada]\x1b[0m\r\n');
  }
});
```

No handler `term.onData` do terminal (onde hoje faz `window.api.shellInput(activeProject, d)`), intercepte o Enter quando aguardando reconexão:

```jsx
term.onData((d) => {
  const t = termsRef.current.get(activeProject);
  if (t && t.awaitingReconnect) {
    if (d === '\r') {
      t.awaitingReconnect = false;
      t.term.write('\r\n\x1b[90m[reconectando…]\x1b[0m\r\n');
      window.api.reconnectRemote(activeProject).then(() => {
        window.api.shellEnsure(activeProject, t.term.cols, t.term.rows).then((res) => {
          if (res && res.error) t.term.write('\r\n\x1b[31m[' + res.error + ']\x1b[0m\r\n');
          else if (res && res.buffer) t.term.write(res.buffer);
        });
      });
    }
    return; // engole o input enquanto aguarda
  }
  window.api.shellInput(activeProject, d);
});
```

- [ ] **Step 2: Confirmar isolamento de segredos**

Verifique que `remotes.secrets` e `known_hosts.json` moram em `app.getPath('userData')` (fora do repositório) — confirme abrindo a pasta userData após um cadastro. Nada deve ser adicionado ao git. Rode:

Run: `git status`
Expected: nenhum arquivo de segredo/known_hosts listado.

- [ ] **Step 3: Build + suíte completa**

Run: `npm run build && npm test`
Expected: build ok; toda a suíte PASS.

- [ ] **Step 4: Verificação manual de reconexão**

Com um projeto remoto aberto, derrube a rede/servidor momentaneamente: a aba mostra `[conexão perdida]`; pressionar Enter reconecta e restaura o shell.

- [ ] **Step 5: Commit**

```bash
git add src/components/ShellView.jsx
git commit -m "feat: reconexão inline do terminal remoto (Camada 1)"
```

---

## Self-Review — cobertura do spec

- **§2 Biblioteca `ssh2`** → Task 0.
- **§3 Costura de transporte (LocalPty/SshShell/isRemote)** → Tasks 5, 6, 10.
- **§4 Conexão (1 Client/host, 4 métodos de auth, keepalive, reconexão, ciclo de vida)** → Tasks 7, 8, 9(remove), 11(reconnect), 14.
- **§5 Modelo de dados & segredos (URI, cfg.remotes, safeStorage, degradações)** → Tasks 1, 3, 8, 9, 10 (skip watcher/tema no remoto).
- **§6 UX (adicionar/importar/testar/status/lazy/reconexão)** → Tasks 9, 12, 13, 14.
- **§7 Erros (host inalcançável, auth, host key TOFU, passphrase, claude ausente, safeStorage indisponível)** → Tasks 3, 7 (hostVerifier), 8 (confirmHostKey), 9 (test/erros), 10 (try/catch).
- **§8 Testes (unit URI/config, contrato de transporte, segredos, smoke opcional)** → Tasks 1–7, 12. *Nota: o smoke opcional `scripts/ssh-smoke.cjs` do spec foi convertido nas verificações manuais fim-a-fim das Tasks 13–14; se quiser o script versionado, adicione-o como um passo extra na Task 13 (roda `pwd` contra `localhost:22` gateado por env var).*
- **§9 Roadmap / §10 Definição de pronto** → checklist coberto pelas verificações manuais das Tasks 10, 13, 14.

**Consistência de tipos:** o contrato `{ write, resize(cols,rows), onData, onExit, kill }` é idêntico em `LocalPty` (Task 5) e `SshShell` (Task 6), consumido igual em `makeTransport` (Task 10). `hostKey`/`parseSshUri`/`buildSshUri` têm assinaturas fixas desde a Task 1 e são reusadas sem divergência.
