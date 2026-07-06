// Smoke do LocalPty: confirma que shell e shellArgs chegam ao ptyLib.
const { LocalPty } = require('../remote/localPty.cjs');

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT: ' + msg);
}

let captured = null;
const fakePtyLib = {
  spawn(shell, args, opts) {
    captured = { shell, args, opts };
    return { write() {}, resize() {}, onData() {}, onExit() {}, kill() {} };
  },
};

// Com shellArgs explícito (caso macOS login shell)
new LocalPty({
  ptyLib: fakePtyLib,
  shell: 'zsh',
  shellArgs: ['-l'],
  env: {},
  cwd: '/tmp',
  cols: 80,
  rows: 24,
});
assert(captured.shell === 'zsh', 'shell repassado');
assert(JSON.stringify(captured.args) === '["-l"]', 'shellArgs repassado ao ptyLib');

// Sem shellArgs: mantém o comportamento antigo (array vazio)
new LocalPty({ ptyLib: fakePtyLib, shell: 'bash', env: {}, cwd: '/tmp', cols: 80, rows: 24 });
assert(JSON.stringify(captured.args) === '[]', 'sem shellArgs -> []');

console.log('localpty-smoke OK');
