export function validateRemoteProfile(p) {
  if (!p || !p.host || !p.host.trim()) return { ok: false, error: 'remote.err_host' };
  if (!p.user || !p.user.trim()) return { ok: false, error: 'remote.err_user' };
  // Diretório remoto é OPCIONAL: em branco = pasta home (resolvida ao salvar).
  if (p.authType === 'key' && !(p.keyPath && p.keyPath.trim())) {
    return { ok: false, error: 'remote.err_keypath' };
  }
  return { ok: true };
}
