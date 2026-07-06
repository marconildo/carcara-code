'use strict';
// Camada canônica de plataforma (Win/Mac/Linux). Ver CLAUDE.md › "Diferenças de
// plataforma". Node-free de propósito: só depende de `process`. Comportamento por SO
// que precise de fs/child_process vive nos módulos que já têm Node.

// TABELA = valores puros por SO (o "locale" de plataforma). Adicionar suporte a um
// SO = preencher a coluna dele aqui.
const TABLE = {
  win32: {
    shellDefault: 'powershell.exe',
    shellEnv: 'COMSPEC',
    loginArgs: [],
    exeExt: '.exe',
    openCmd: 'start',
  },
  darwin: {
    shellDefault: 'zsh',
    shellEnv: 'SHELL',
    loginArgs: ['-l'],
    exeExt: '',
    openCmd: 'open',
  },
  linux: {
    shellDefault: 'bash',
    shellEnv: 'SHELL',
    loginArgs: [],
    exeExt: '',
    openCmd: 'xdg-open',
  },
};

function tableFor(platform = process.platform) {
  return TABLE[platform] || TABLE.linux;
}

// Shell interativo do SO (preserva o antigo shellForOS: win usa COMSPEC, resto usa SHELL).
function shellFor(platform = process.platform, env = process.env) {
  const t = tableFor(platform);
  return env[t.shellEnv] || t.shellDefault;
}

// Args para abrir o shell como login shell (só o macOS precisa, p/ herdar o PATH).
function loginArgsFor(platform = process.platform) {
  return tableFor(platform).loginArgs;
}

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const isLinux = process.platform === 'linux';

module.exports = { TABLE, tableFor, shellFor, loginArgsFor, isWin, isMac, isLinux };
