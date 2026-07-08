// Toast global do Carcará Code.
// Um pub/sub mínimo em nível de módulo: qualquer componente chama `toast(...)`
// sem precisar de Context nem prop-drilling. O <Toaster /> (montado uma vez no
// App) assina e renderiza a pilha. É assim que "avisos do sistema" (git, preview,
// código…) passam a falar a mesma língua em vez de cada painel inventar a sua.

const listeners = new Set();
let counter = 0;

/** Assina os toasts. Retorna a função de cancelamento (pra usar no cleanup). */
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Dispara um toast.
 * @param {string} message  Texto principal — diga o que aconteceu, voz ativa.
 * @param {object} [opts]
 * @param {'success'|'error'|'warning'|'info'} [opts.kind='info']
 * @param {string} [opts.title]                Rótulo (eyebrow); cai no padrão do kind.
 * @param {{label:string,onClick:()=>void}} [opts.action]  Ação opcional.
 * @param {boolean} [opts.copyable]  Se true e não houver `action`, injeta uma ação
 *   "Copiar" que copia `message` pro clipboard.
 * @param {number} [opts.duration]             ms até sumir; 0 = fica até fechar.
 */
export function toast(message, opts = {}) {
  const kind = opts.kind || 'info';
  let action = opts.action;
  if (opts.copyable && !action) {
    action = {
      label: 'Copiar',
      onClick: () => {
        const text = String(message);
        if (typeof window !== 'undefined' && window.api?.copyText) window.api.copyText(text);
        else if (typeof navigator !== 'undefined') navigator.clipboard?.writeText(text);
      },
    };
  }
  const t = {
    id: ++counter,
    message,
    kind,
    title: opts.title,
    action,
    duration: opts.duration ?? (kind === 'error' ? 7000 : 2800),
  };
  listeners.forEach((fn) => fn(t));
  return t.id;
}

toast.success = (m, o) => toast(m, { ...o, kind: 'success' });
toast.error = (m, o) => toast(m, { ...o, kind: 'error' });
toast.warning = (m, o) => toast(m, { ...o, kind: 'warning' });
toast.info = (m, o) => toast(m, { ...o, kind: 'info' });
