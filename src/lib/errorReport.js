// Formato único do "erro copiável", usado tanto no card de erro (ErrorBoundary)
// quanto nos toasts de erro. Fica fora do componente pra dar pra testar sem DOM.
// Partes vazias são omitidas: um toast só tem `message`; um crash de painel tem
// code + label + stack.
export function formatErrorPayload({ code, label, message, stack } = {}) {
  const head = [code && `[${code}]`, label].filter(Boolean).join(' ');
  const lines = [];
  if (head) lines.push(head);
  if (message) lines.push(String(message));
  let out = lines.join('\n');
  if (stack) out += `\n\n${stack}`;
  return out;
}
