// Aba "Gerenciar IAs": lista as CLIs de IA (instalada/versão/update) e roda
// instalação/atualização pelo instalador oficial, com um xterm ao vivo à direita.
// Reaproveita os canais aiInstall:* do main (PTY real). Ver
// docs/superpowers/specs/2026-07-10-gestao-clis-ia-design.md.
import { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { Loader2 } from 'lucide-react';
import { useT } from '@/lib/i18n';
import { CliBadge, OPT } from '@/lib/aiOptions.jsx';
import { cn } from '@/lib/utils';

const LABEL = (key) => OPT[key]?.label ?? key;
const keep = (r) => r.key !== 'custom' && r.key !== 'shell'; // custom/shell não são instaláveis

export default function AiManager({ initialInstallKey = null }) {
  const t = useT();
  const [rows, setRows] = useState([]); // status por CLI
  const [busy, setBusy] = useState(null); // key em instalação/atualização
  const [busyMode, setBusyMode] = useState(null); // 'install' | 'update' — só rótulo do botão
  const [installId, setInstallId] = useState(null);
  const termHostRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  // O listener de teclado do xterm é registrado uma vez (efeito de montagem); usamos um ref
  // pra sempre encaminhar pro installId mais recente, sem precisar recriar o terminal.
  const installIdRef = useRef(null);
  installIdRef.current = installId;

  const refresh = useCallback(async () => {
    // Fase 1 (rápida, só detecção local): renderiza a lista NA HORA. Cada linha entra
    // como `checking:true` — a área de status mostra "verificando…" até a fase 2.
    try {
      const det = await window.api.aiDetected();
      setRows(det.filter(keep).map((r) => ({ ...r, checking: true })));
    } catch {
      setRows([]);
    }
    // Fase 2 (lenta, com rede): force=true fura o cache de 24h de versão pra refletir o
    // "latest" fresco e preencher latest/updateAvailable. A lista já está visível.
    try {
      const s = await window.api.aiStatus(true);
      setRows(s.filter(keep).map((r) => ({ ...r, checking: false })));
    } catch {
      // Rede caiu: mantém as linhas da fase 1, só encerra o "verificando…".
      setRows((prev) => prev.map((r) => ({ ...r, checking: false })));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // xterm ao vivo: mostra o progresso da instalação e encaminha entrada do usuário
  // (senha de sudo, confirmações y/n do instalador, etc.) de volta pro PTY.
  useEffect(() => {
    if (!termHostRef.current || termRef.current) return;
    const term = new Terminal({
      fontSize: 12,
      convertEol: true,
      disableStdin: false,
      theme: { background: '#0d0f12' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(termHostRef.current);
    termRef.current = term;
    fitRef.current = fit;
    // Mede só depois do layout assentar (modal/sub-aba podem não ter estabilizado
    // ainda no momento do mount), igual ao ShellView.
    requestAnimationFrame(() => {
      try {
        fit.fit();
      } catch {}
    });
    term.onData((data) => {
      const id = installIdRef.current;
      if (id) window.api.aiInstallInput(id, data);
    });
    const onResize = () => {
      try {
        fit.fit();
        const id = installIdRef.current;
        if (id) window.api.aiInstallResize(id, term.cols, term.rows);
      } catch {}
    };
    window.addEventListener('resize', onResize);
    // Backstop pra mudanças internas de layout (abrir modal, trocar sub-aba) que
    // não disparam o resize do window, igual ao ShellView.
    const ro = new ResizeObserver(onResize);
    ro.observe(termHostRef.current);
    return () => {
      window.removeEventListener('resize', onResize);
      ro.disconnect();
      term.dispose();
      termRef.current = null;
    };
  }, []);

  // eventos de stream/fim
  useEffect(() => {
    // Só roda uma instalação por vez (guard do `busy`), então não há stream concorrente
    // a diferenciar aqui. Filtrar por `installId` deixaria de fora o eco "$ <comando>" —
    // ele chega antes de setInstallId(id) commitar, com installId ainda null.
    const offData = window.api.on('aiInstall:data', ({ data }) => {
      if (termRef.current) termRef.current.write(data);
    });
    const offDone = window.api.on('aiInstall:done', async ({ installId: id, ok, error }) => {
      if (id !== installId) return;
      const key = busy;
      const label = LABEL(key);
      const term = termRef.current;
      // Falha real (kill do usuário não traz error → sem linha vermelha).
      if (term && !ok && error) term.write(`\r\n\x1b[31m${error}\x1b[0m\r\n`);
      // Mensagem HONESTA: re-checa a realidade (fura o cache) ANTES de decidir. Instaladores
      // que se auto-atualizam em background podem terminar sem mudar a versão — nesse caso
      // NÃO afirmamos sucesso verde.
      let fresh = [];
      try {
        fresh = (await window.api.aiStatus(true)).filter(keep);
      } catch {
        /* rede caiu: sem re-check, cai fora do bloco de mensagem */
      }
      const row = fresh.find((r) => r.key === key);
      if (ok && term && row) {
        if (row.installed && !row.updateAvailable) {
          term.write(
            `\r\n\x1b[32m✓ ${t('settings.aiDoneUpdated', { label, v: row.version })}\x1b[0m\r\n`,
          );
        } else if (row.updateAvailable) {
          term.write(
            `\r\n\x1b[33m⚠ ${t('settings.aiDoneNoChange', { label, v: row.version })}\x1b[0m\r\n`,
          );
        }
      }
      if (fresh.length) setRows(fresh.map((r) => ({ ...r, checking: false })));
      setBusy(null);
      setBusyMode(null);
      setInstallId(null);
    });
    return () => {
      offData && offData();
      offDone && offDone();
    };
  }, [installId, busy, t]);

  // Encerra o instalador travado (prompt interativo / CLI aberta). Mata o PTY → o main
  // dispara aiInstall:done (ok:false, sem error → sem linha vermelha) e o busy limpa.
  const stop = useCallback(() => {
    const id = installIdRef.current;
    if (!id) return;
    window.api.aiInstallCancel(id);
    if (termRef.current) termRef.current.write('\r\n\x1b[2mEncerrado.\x1b[0m\r\n');
  }, []);

  const start = useCallback(
    async (key, mode) => {
      if (busy) return;
      setBusy(key);
      setBusyMode(mode);
      if (termRef.current) termRef.current.clear();
      const { installId: id } = await window.api.aiInstallStart(key, mode);
      setInstallId(id);
      if (fitRef.current && termRef.current) {
        window.api.aiInstallResize(id, termRef.current.cols, termRef.current.rows);
      }
    },
    [busy],
  );

  // auto-install vindo de um chip (Task 8)
  useEffect(() => {
    if (initialInstallKey) start(initialInstallKey, 'install');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialInstallKey]);

  return (
    <div className="flex h-[300px] gap-4">
      {/* Lista */}
      <div className="w-[46%] shrink-0 space-y-2 overflow-auto">
        {rows.map((r) => {
          const installing = busy === r.key;
          return (
            <div
              key={r.key}
              className={cn(
                'flex items-center gap-3 rounded-lg border p-3',
                !r.installed && 'opacity-60 grayscale',
                installing && 'border-primary ring-1 ring-primary',
              )}
            >
              <CliBadge optKey={r.key} />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{LABEL(r.key)}</div>
                <div className="text-xs text-muted-foreground">
                  {installing ? (
                    busyMode === 'update' ? (
                      t('settings.aiUpdating')
                    ) : (
                      t('settings.aiInstalling')
                    )
                  ) : !r.installed ? (
                    t('settings.aiNotInstalled')
                  ) : r.checking ? (
                    // Fase 1 (ai:detected): sabemos instalada+versão, mas ainda não o "latest".
                    <span className="inline-flex items-center gap-1">
                      <Loader2 className="size-3 animate-spin" />
                      {t('settings.aiChecking')}
                    </span>
                  ) : r.updateAvailable ? (
                    t('settings.aiUpdateAvailable', { v: r.latest })
                  ) : (
                    t('settings.aiUpToDate', { v: r.version })
                  )}
                </div>
              </div>
              {installing ? (
                // Ocupada: spinner + rótulo, desabilitada.
                <button
                  type="button"
                  disabled
                  className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[13px] text-muted-foreground opacity-70"
                >
                  <Loader2 className="size-3.5 animate-spin" />
                  {busyMode === 'update' ? t('settings.aiUpdating') : t('settings.aiInstalling')}
                </button>
              ) : r.installed && r.checking ? (
                // Fase 1: ainda não sabemos se há update — nenhum botão de ação até o ai:status.
                <span aria-hidden className="w-1" />
              ) : r.installed && r.updateAvailable ? (
                // Update disponível: botão em destaque (laranja/primary).
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={() => start(r.key, 'update')}
                  className="inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-[13px] font-medium text-primary-foreground transition-colors hover:opacity-90 disabled:opacity-40"
                >
                  {t('settings.aiUpdate')}
                </button>
              ) : r.installed ? (
                // Em dia: sem "Atualizar" gritante — só um "Reinstalar" discreto (fantasma).
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={() => start(r.key, 'install')}
                  className="rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
                >
                  {t('settings.aiReinstall')}
                </button>
              ) : (
                // Não instalada: instalar.
                <button
                  type="button"
                  disabled={!!busy || !r.installable}
                  onClick={() => start(r.key, 'install')}
                  className="rounded-md border border-primary px-2.5 py-1.5 text-[13px] text-primary transition-colors hover:bg-primary/10 disabled:opacity-40"
                >
                  {t('settings.aiInstall')}
                </button>
              )}
            </div>
          );
        })}
      </div>
      {/* Coluna do terminal ao vivo — altura fixa (~300px) pra não esticar o modal inteiro. */}
      <div className="flex h-full flex-1 flex-col gap-1.5 overflow-hidden">
        {/* Aviso persistente: o PTY é um TTY real; alguns instaladores perguntam ou abrem
            a CLI e nunca saem. O usuário responde no terminal ou clica Encerrar. */}
        <div className="flex items-start justify-between gap-2">
          <p className="text-[11px] leading-tight text-muted-foreground">
            {t('settings.aiInstallHint')}
          </p>
          {busy && installId ? (
            <button
              type="button"
              onClick={stop}
              className="shrink-0 rounded-md border border-destructive/60 px-2 py-1 text-xs text-destructive transition-colors hover:bg-destructive/10"
            >
              {t('settings.aiInstallStop')}
            </button>
          ) : null}
        </div>
        <div className="flex-1 overflow-hidden rounded-lg border bg-[#0d0f12]">
          <div ref={termHostRef} className="h-full w-full p-2" />
        </div>
      </div>
    </div>
  );
}
