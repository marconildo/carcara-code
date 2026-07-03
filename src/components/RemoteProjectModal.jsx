import { useState } from 'react';
import { validateRemoteProfile } from '@/lib/remoteProfile.js';
import { useT } from '@/lib/i18n';
import { toast } from '@/lib/toast.js';

const EMPTY = { host: '', port: 22, user: '', authType: 'key', keyPath: '', remoteDir: '', label: '' };

export function RemoteProjectModal({ open, onClose, onAdded }) {
  const t = useT();
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
    if (!v.ok) { setTest({ ok: false, message: t(v.error) }); return; }
    setBusy(true);
    setTest(await window.api.testRemote(p, secret));
    setBusy(false);
  }
  async function save() {
    const v = validateRemoteProfile(p);
    if (!v.ok) { setTest({ ok: false, message: t(v.error) }); return; }
    setBusy(true);
    const res = await window.api.addRemote(p, secret);
    setBusy(false);
    if (res && res.secretSaved === false && (p.authType === 'password' || p.authType === 'key') && secret) {
      toast(t('remote.warn_secret'));
    }
    onAdded?.(res.uri);
    onClose?.();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="w-[460px] rounded-xl border border-border bg-background p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-3 text-lg font-semibold">{t('remote.title')}</h2>
        <button className="mb-3 text-sm text-primary underline" onClick={importConfig} disabled={busy}>{t('remote.import_config')}</button>
        {hosts && (
          <ul className="mb-3 max-h-32 overflow-auto rounded border border-border">
            {hosts.length === 0 && <li className="p-2 text-sm text-muted-foreground">{t('remote.no_hosts')}</li>}
            {hosts.map((h) => (
              <li key={h.host}><button className="w-full p-2 text-left text-sm hover:bg-muted" onClick={() => pickHost(h)}>{h.host} — {h.hostName || '?'}</button></li>
            ))}
          </ul>
        )}
        <div className="grid grid-cols-2 gap-2">
          <input className="col-span-2 rounded border border-border bg-background p-2 text-sm" placeholder={t('remote.ph_host')} value={p.host} onChange={set('host')} />
          <input className="rounded border border-border bg-background p-2 text-sm" placeholder={t('remote.ph_user')} value={p.user} onChange={set('user')} />
          <input className="rounded border border-border bg-background p-2 text-sm" placeholder={t('remote.ph_port')} value={p.port} onChange={set('port')} />
          <select className="col-span-2 rounded border border-border bg-background p-2 text-sm" value={p.authType} onChange={set('authType')}>
            <option value="key">{t('remote.auth_key')}</option>
            <option value="password">{t('remote.auth_password')}</option>
            <option value="agent">{t('remote.auth_agent')}</option>
          </select>
          {p.authType === 'key' && (
            <input className="col-span-2 rounded border border-border bg-background p-2 text-sm" placeholder={t('remote.ph_keypath')} value={p.keyPath} onChange={set('keyPath')} />
          )}
          {(p.authType === 'password' || p.authType === 'key') && (
            <input type="password" className="col-span-2 rounded border border-border bg-background p-2 text-sm" placeholder={p.authType === 'key' ? t('remote.ph_passphrase') : t('remote.ph_password')} value={secret} onChange={(e) => setSecret(e.target.value)} />
          )}
          <input className="col-span-2 rounded border border-border bg-background p-2 text-sm" placeholder={t('remote.ph_remotedir')} value={p.remoteDir} onChange={set('remoteDir')} />
          <input className="col-span-2 rounded border border-border bg-background p-2 text-sm" placeholder={t('remote.ph_label')} value={p.label} onChange={set('label')} />
        </div>
        {test && (
          <p className={`mt-2 text-sm ${test.ok ? 'text-green-600' : 'text-red-500'}`}>{test.ok ? '✓ ' : '✗ '}{test.message}</p>
        )}
        <div className="mt-4 flex justify-between">
          <button className="rounded border border-border px-3 py-1.5 text-sm" onClick={doTest} disabled={busy}>{t('remote.test_btn')}</button>
          <div className="flex gap-2">
            <button className="rounded border border-border px-3 py-1.5 text-sm" onClick={onClose} disabled={busy}>{t('remote.cancel')}</button>
            <button className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground" onClick={save} disabled={busy}>{t('remote.save')}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
