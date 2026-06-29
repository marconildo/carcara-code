import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Terminal, X, Copy, Bug, Loader2, Crosshair, ExternalLink } from 'lucide-react';
// Ícones animados (lucide-animated): animam no hover. Só os que têm versão no
// registry; Crosshair/Bug seguem estáticos (não há equivalente animado).
import { EarthIcon } from './ui/earth.jsx';
import { ChevronsLeftRightIcon } from './ui/chevrons-left-right.jsx';
import { GitBranchIcon } from './ui/git-branch.jsx';
import { ChevronDownIcon } from './ui/chevron-down.jsx';
import { ZapIcon } from './ui/zap.jsx';
import { PlugZapIcon } from './ui/plug-zap.jsx';
import { PenToolIcon } from './ui/pen-tool.jsx';
import { ArrowLeftIcon } from './ui/arrow-left.jsx';
import { ArrowRightIcon } from './ui/arrow-right.jsx';
import { RotateCWIcon } from './ui/rotate-cw.jsx';
import { ClockIcon } from './ui/clock.jsx';
import { TerminalIcon } from './ui/terminal.jsx';
import { HoverIcon } from './ui/hover-icon.jsx';
import { Tabs, TabsList, TabsTrigger } from './ui/tabs.jsx';
import { Input } from './ui/input.jsx';
import { Button } from './ui/button.jsx';
import { ResizeBar } from './ui/resize-bar.jsx';
import { DragHandle } from './ui/drag-handle.jsx';
import { EmptyState } from './ui/empty-state.jsx';
import { cn } from '@/lib/utils';
import { ErrorBoundary } from './ErrorBoundary.jsx';
import { INJECT, CLEANUP, GRAB_SENTINEL, GRAB_CANCEL } from '@/lib/grabScript';
import { useT } from '@/lib/i18n';

// Faz os botões laterais do mouse (voltar/avançar) funcionarem dentro do preview.
// O Electron não identifica esses botões no input-event do main (button=undefined),
// mas no DOM da página eles vêm certos (button 3 = voltar, 4 = avançar) — igual a
// qualquer site de teste de mouse. Injetado a cada navegação (dom-ready).
const NAV_INJECT = `(function(){
  if (window.__carcaraNav) return; window.__carcaraNav = true;
  function h(e){
    if (e.button === 3 || e.button === 4){
      e.preventDefault();
      if (e.type === 'mouseup'){ if (e.button === 3) history.back(); else history.forward(); }
    }
  }
  ['mousedown','mouseup','auxclick'].forEach(function(t){ window.addEventListener(t, h, true); });
})();`;

// Painéis pesados carregados sob demanda (code-splitting). CodeView arrasta todo o
// CodeMirror + 16 linguagens; ShellView arrasta o xterm; cada um vira um chunk
// separado que só baixa quando a aba/terminal correspondente é aberta — fora do
// bundle inicial, então o boot fica bem mais leve.
const CodeView = lazy(() => import('./CodeView.jsx').then((m) => ({ default: m.CodeView })));
const GitPanel = lazy(() => import('./GitPanel.jsx').then((m) => ({ default: m.GitPanel })));
const ApiPanel = lazy(() => import('./ApiPanel.jsx').then((m) => ({ default: m.ApiPanel })));
const ShellView = lazy(() => import('./ShellView.jsx').then((m) => ({ default: m.ShellView })));
const MCPPanel = lazy(() => import('./MCPPanel.jsx').then((m) => ({ default: m.MCPPanel })));
const TldrawPanel = lazy(() => import('./TldrawPanel.jsx').then((m) => ({ default: m.TldrawPanel })));
const CheckpointsPanel = lazy(() => import('./CheckpointsPanel.jsx').then((m) => ({ default: m.CheckpointsPanel })));

// Fallback enquanto o chunk do painel carrega (costuma ser instantâneo no disco).
function PanelFallback() {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-background text-muted-foreground">
      <Loader2 className="size-5 animate-spin" />
    </div>
  );
}

// Painel lazy isolado: o ErrorBoundary segura um crash de render OU um chunk que falhou
// ao carregar (import() rejeitado) e mostra o card de erro só nesta área — a barra de abas
// e o resto do app seguem vivos. Recuperação: o botão "Tentar novamente" do card, ou sair
// e voltar pra aba (o painel é condicional, então remonta limpo sozinho).
function LazyPanel({ label, children }) {
  return (
    <ErrorBoundary label={label}>
      <Suspense fallback={<PanelFallback />}>{children}</Suspense>
    </ErrorBoundary>
  );
}

// Menu "Ferramentas" (seta ˅) com as abas menos usadas (API, MCP), pra enxugar a barra.
function MoreTools({ view, onPick }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const TOOLS = [
    { value: 'history', label: t('preview.history'), Icon: ClockIcon },
    { value: 'api', label: t('preview.api'), Icon: ZapIcon },
    { value: 'mcp', label: t('preview.mcp'), Icon: PlugZapIcon },
    { value: 'board', label: t('preview.board'), Icon: PenToolIcon },
  ];
  const active = TOOLS.find((tool) => tool.value === view);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={t('preview.more_tools')}
        className={cn(
          'flex h-7 items-center gap-0.5 rounded-md px-1.5 transition-colors [&_svg]:size-[15px]',
          active ? 'text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
        )}
      >
        {active && <HoverIcon as={active.Icon} />}
        <ChevronDownIcon className={cn('transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="absolute left-0 top-9 z-50 min-w-[150px] overflow-hidden rounded-md border bg-popover py-1 shadow-md">
          {TOOLS.map((tool) => (
            <button
              key={tool.value}
              type="button"
              onClick={() => { onPick(tool.value); setOpen(false); }}
              className={cn(
                'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-muted [&_svg]:size-4',
                view === tool.value && 'font-medium text-primary'
              )}
            >
              <HoverIcon as={tool.Icon} />{tool.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Botão de ícone pequeno e neutro da barra (cor só no hover/ativo).
function ToolButton({ active, className, children, ...props }) {
  return (
    <button
      type="button"
      className={cn(
        // Superfície de descanso: sem ela o botão é "texto fantasma" e some na barra.
        'grid h-7 w-7 place-items-center rounded-md bg-secondary text-muted-foreground transition-colors',
        'hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40',
        '[&_svg]:size-[15px]',
        // Ativo = brasa, igual à aba selecionada (data-[state=active]:text-primary).
        active && 'bg-background text-primary shadow-sm hover:bg-background hover:text-primary',
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
}

// Sessão isolada por projeto. Sem isso, todos os previews dividem a sessão padrão
// do Electron (mesmo cache, localStorage e SERVICE WORKER). Um SW registrado por
// um site (ex.: localhost:8080) passa a interceptar e servir aquele site pra
// qualquer outro projeto que rode na mesma porta/origem — inclusive depois de
// fechar e reabrir, porque fica gravado em disco. Uma partition única por projeto
// dá cache/SW/storage próprios, isolando de verdade. Hash simples do caminho.
function partitionFor(projectPath) {
  let h = 0;
  for (let i = 0; i < projectPath.length; i++) h = (h * 31 + projectPath.charCodeAt(i)) | 0;
  return 'persist:preview-' + (h >>> 0).toString(36);
}

export function PreviewPanel({ active, onProjectsChanged, controlsRef, onModeChange }) {
  const t = useT();
  const [view, setView] = useState('preview');
  const [openRequest, setOpenRequest] = useState(null); // { path, name, seq } — abrir arquivo na aba Código (paleta)
  const openSeqRef = useRef(0);
  const [mode, setMode] = useState('empty'); // empty | log | web
  const [url, setUrl] = useState('');
  const [termOpen, setTermOpen] = useState(false);
  const [termHeight, setTermHeight] = useState(300);
  const [copied, setCopied] = useState(false);
  const [devtoolsOpen, setDevtoolsOpen] = useState(false);
  const [devtoolsWidth, setDevtoolsWidth] = useState(() => Number(localStorage.getItem('devtoolsWidth')) || 520);
  const [dtDragging, setDtDragging] = useState(false);
  const [termDragging, setTermDragging] = useState(false);
  const [grabbing, setGrabbing] = useState(false);   // modo "selecionar elemento" ativo
  const [grabbed, setGrabbed] = useState(false);      // toast "Elemento copiado!"
  const [canBack, setCanBack] = useState(false);      // navegação do preview (voltar/avançar)
  const [canFwd, setCanFwd] = useState(false);
  const [webFocused, setWebFocused] = useState(false); // foco está DENTRO do webview do projeto ativo
  const bodyRowRef = useRef(null);
  const webviewsRef = useRef(new Map()); // path -> webview element (um por projeto)
  const containerRef = useRef(null);
  const logRef = useRef(null);
  const urlsRef = useRef(new Map()); // path -> url
  const activePathRef = useRef(null);
  const manualStopRef = useRef(new Set()); // paths parados pelo usuário (botão Parar)
  const devtoolsHostRef = useRef(null);  // div que segura o webview do DevTools
  const devtoolsRef = useRef(null);      // o <webview> que hospeda o DevTools
  const toggleDevtoolsRef = useRef(() => {});

  const appendLog = useCallback((projectPath, text) => {
    if (activePathRef.current !== projectPath || !logRef.current) return;
    const clean = text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
    const el = logRef.current;
    el.textContent += clean;
    if (el.textContent.length > 40000) el.textContent = el.textContent.slice(-30000);
    el.scrollTop = el.scrollHeight;
  }, []);

  // Cria (ou pega) o webview DESTE projeto. Cada projeto tem o seu.
  const getWebview = useCallback((projectPath) => {
    let w = webviewsRef.current.get(projectPath);
    if (w) return w;
    w = document.createElement('webview');
    // Isola a sessão deste projeto (precisa ser definido ANTES de anexar/navegar).
    w.setAttribute('partition', partitionFor(projectPath));
    w.style.position = 'absolute';
    w.style.inset = '0';
    w.style.width = '100%';
    w.style.height = '100%';
    w.style.background = '#fff';
    w.style.display = 'none';
    w._retry = 0;
    containerRef.current.appendChild(w);
    const syncNav = () => { if (activePathRef.current === projectPath) { try { setCanBack(w.canGoBack()); setCanFwd(w.canGoForward()); } catch {} } };
    w.addEventListener('did-navigate', (e) => { if (e.url && activePathRef.current === projectPath) setUrl(e.url); syncNav(); });
    w.addEventListener('did-navigate-in-page', (e) => { if (e.isMainFrame && e.url && activePathRef.current === projectPath) setUrl(e.url); syncNav(); });
    w.addEventListener('did-fail-load', (e) => {
      if (e.errorCode === -3 || w.style.display === 'none') return;
      if (w._retry++ < 8) setTimeout(() => { try { w.reload(); } catch {} }, 1000);
    });
    w.addEventListener('did-finish-load', () => { w._retry = 0; syncNav(); });
    // Botões laterais do mouse → voltar/avançar (detecta no DOM da página).
    w.addEventListener('dom-ready', () => { try { w.executeJavaScript(NAV_INJECT); } catch {} });
    // Ponte do "selecionar elemento": o script injetado emite o pacote via console.
    w.addEventListener('console-message', (e) => {
      const msg = e.message || '';
      if (msg.startsWith(GRAB_SENTINEL)) {
        try {
          const { md } = JSON.parse(msg.slice(GRAB_SENTINEL.length));
          window.api.copyText(md);
          setGrabbed(true);
          setTimeout(() => setGrabbed(false), 2200);
        } catch {}
        setGrabbing(false);
      } else if (msg.startsWith(GRAB_CANCEL)) {
        setGrabbing(false);
      }
    });
    webviewsRef.current.set(projectPath, w);
    return w;
  }, []);

  // Foco do webview (vem do main): liga a borda só quando o id é o do projeto ativo.
  useEffect(() => {
    return window.api.on('webview:focus', ({ id, focused }) => {
      const w = activePathRef.current && webviewsRef.current.get(activePathRef.current);
      let activeId = null;
      try { activeId = w && w.getWebContentsId(); } catch {}
      if (activeId != null && id === activeId) setWebFocused(focused);
    });
  }, []);

  // Some com a borda ao trocar de projeto ou sair do preview/site (o foco antigo
  // não vale mais; volta a aparecer quando clicarem no novo webview).
  useEffect(() => { setWebFocused(false); }, [active?.path]);
  useEffect(() => { if (!(view === 'preview' && mode === 'web')) setWebFocused(false); }, [view, mode]);

  // Navegação do preview (voltar/avançar), estilo navegador.
  const goBack = useCallback(() => {
    const w = active && webviewsRef.current.get(active.path);
    if (w && w.canGoBack()) w.goBack();
  }, [active]);
  const goFwd = useCallback(() => {
    const w = active && webviewsRef.current.get(active.path);
    if (w && w.canGoForward()) w.goForward();
  }, [active]);

  // Botões laterais do mouse (vêm do main via app-command) — lê o projeto ativo pelo ref.
  useEffect(() => {
    const nav = (dir) => {
      const p = activePathRef.current;
      const w = p && webviewsRef.current.get(p);
      if (!w) return;
      if (dir === 'back' && w.canGoBack()) w.goBack();
      if (dir === 'fwd' && w.canGoForward()) w.goForward();
    };
    window.api.on('nav:back', () => nav('back'));
    window.api.on('nav:forward', () => nav('fwd'));
  }, []);

  // Liga/desliga o modo "selecionar elemento" no webview do projeto ativo.
  const toggleGrab = useCallback(() => {
    if (!active) return;
    const w = webviewsRef.current.get(active.path);
    if (!w) return;
    if (grabbing) {
      try { w.executeJavaScript(CLEANUP); } catch {}
      setGrabbing(false);
    } else {
      w.executeJavaScript(INJECT).then(() => setGrabbing(true)).catch(() => {});
    }
  }, [active, grabbing]);

  // Sai do modo "selecionar" se deixar o preview/site (troca de aba, para o servidor, etc.).
  useEffect(() => {
    if (grabbing && !(view === 'preview' && mode === 'web')) {
      for (const w of webviewsRef.current.values()) { try { w.executeJavaScript(CLEANUP); } catch {} }
      setGrabbing(false);
    }
  }, [view, mode, grabbing]);

  // Atualiza o estado dos botões voltar/avançar ao trocar de projeto.
  useEffect(() => {
    const w = active && webviewsRef.current.get(active.path);
    try { setCanBack(!!w && w.canGoBack()); setCanFwd(!!w && w.canGoForward()); } catch { setCanBack(false); setCanFwd(false); }
  }, [active, mode]);

  // Esc cancela o modo mesmo quando o foco está na janela do app (não no webview).
  useEffect(() => {
    if (!grabbing) return;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      for (const w of webviewsRef.current.values()) { try { w.executeJavaScript(CLEANUP); } catch {} }
      setGrabbing(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [grabbing]);

  const showWebFor = useCallback((projectPath, u) => {
    urlsRef.current.set(projectPath, u);
    const w = getWebview(projectPath);
    if (w.getAttribute('src') !== u) w.src = u;
    if (activePathRef.current === projectPath) { setUrl(u); setMode('web'); }
  }, [getWebview]);

  // DevTools encaixado (definido antes dos effects que o usam, pra não dar TDZ).
  const dockDevtools = useCallback(() => {
    const pv = active && webviewsRef.current.get(active.path);
    if (pv && devtoolsRef.current) {
      try { window.api.dockDevTools(pv.getWebContentsId(), devtoolsRef.current.getWebContentsId()); } catch {}
    }
  }, [active]);

  const toggleDevtools = useCallback(() => {
    if (!active) return;
    const pv = webviewsRef.current.get(active.path);
    if (devtoolsOpen) {
      if (pv) { try { window.api.undockDevTools(pv.getWebContentsId()); } catch {} }
      setDevtoolsOpen(false);
    } else {
      setDevtoolsOpen(true);
      requestAnimationFrame(() => requestAnimationFrame(dockDevtools));
    }
  }, [active, devtoolsOpen, dockDevtools]);
  toggleDevtoolsRef.current = toggleDevtools;

  // Arrasta a borda esquerda do painel de DevTools pra aumentar/diminuir (igual os outros).
  const startDevtoolsResize = (e) => {
    e.preventDefault();
    const rect = bodyRowRef.current.getBoundingClientRect();
    setDtDragging(true);
    document.body.style.cursor = 'col-resize';
    const onMove = (ev) => {
      const w = Math.max(300, Math.min(rect.right - ev.clientX, rect.width - 320));
      setDevtoolsWidth(w);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      setDtDragging(false);
      setDevtoolsWidth((w) => { localStorage.setItem('devtoolsWidth', String(Math.round(w))); return w; });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // Listeners de IPC (uma vez).
  useEffect(() => {
    window.api.on('preview:phase', ({ projectPath, text }) => appendLog(projectPath, '\n> ' + text + '\n'));
    window.api.on('preview:log', ({ projectPath, chunk }) => appendLog(projectPath, chunk));
    window.api.on('preview:ready', ({ projectPath, url: u }) => {
      showWebFor(projectPath, u);
      onProjectsChanged?.();
    });
    window.api.on('preview:exit', ({ projectPath }) => {
      const hadUrl = urlsRef.current.has(projectPath);
      const wasManual = manualStopRef.current.delete(projectPath); // Set.delete devolve true se existia
      urlsRef.current.delete(projectPath);
      const w = webviewsRef.current.get(projectPath);
      if (w) { w.remove(); webviewsRef.current.delete(projectPath); }
      if (activePathRef.current === projectPath) {
        if (wasManual || hadUrl) {
          setMode('empty'); // parado pelo usuário, ou já tinha aberto e o servidor caiu
        } else {
          setMode('log'); // falhou ao subir: mantém o log à mostra pra ver o erro
          appendLog(projectPath, t('preview.log_exited'));
        }
      }
      onProjectsChanged?.();
    });
  }, [appendLog, showWebFor, onProjectsChanged]);

  // Cria o webview que vai HOSPEDAR o DevTools (à direita). Existe sempre (escondido quando fechado).
  useEffect(() => {
    const w = document.createElement('webview');
    w.setAttribute('src', 'about:blank');
    w.style.width = '100%';
    w.style.height = '100%';
    devtoolsHostRef.current.appendChild(w);
    devtoolsRef.current = w;
    return () => { try { w.remove(); } catch {} devtoolsRef.current = null; };
  }, []);

  // F12 / "Inspecionar elemento" (vêm do processo principal) abrem/fecham o DevTools.
  useEffect(() => {
    window.api.on('devtools:toggle', () => toggleDevtoolsRef.current());
  }, []);

  // Se trocar de projeto com o DevTools aberto, re-encaixa no preview do novo projeto.
  useEffect(() => {
    if (devtoolsOpen) requestAnimationFrame(dockDevtools);
  }, [active, devtoolsOpen, dockDevtools]);

  // ---- Estado de UI por projeto (aba ativa, terminal, DevTools) ----
  // Cada projeto lembra em que aba estava (Preview/Código/Git) e se tinha o
  // terminal/DevTools aberto. Sem isso, abrir o terminal/DevTools num projeto
  // "vazava" pros outros. O 'dono' evita que a troca grave no projeto errado.
  const uiByProjectRef = useRef({});
  const stateOwnerRef = useRef(null);

  // Restaura o estado salvo ao trocar de projeto.
  useEffect(() => {
    const p = active?.path || null;
    stateOwnerRef.current = p;
    const s = (p && uiByProjectRef.current[p]) || null;
    setView(s?.view ?? 'preview');
    setTermOpen(s?.termOpen ?? false);
    setDevtoolsOpen(s?.devtoolsOpen ?? false);
  }, [active?.path]);

  // Salva o estado do projeto dono atual sempre que muda.
  useEffect(() => {
    const p = stateOwnerRef.current;
    if (p) uiByProjectRef.current[p] = { view, termOpen, devtoolsOpen };
  }, [view, termOpen, devtoolsOpen]);

  // Mostra só o webview do projeto ATIVO; esconde todos os outros.
  useEffect(() => {
    const ap = active?.path || null;
    for (const [p, w] of webviewsRef.current) {
      w.style.display = p === ap && view === 'preview' && mode === 'web' ? 'flex' : 'none';
    }
  }, [view, mode, active]);

  // Troca de projeto: inicia/retoma o preview do projeto ativo.
  useEffect(() => {
    activePathRef.current = active?.path || null;
    if (!active) { setMode('empty'); setUrl(''); return; }
    setUrl(urlsRef.current.get(active.path) || active.name);

    (async () => {
      if (urlsRef.current.has(active.path)) { showWebFor(active.path, urlsRef.current.get(active.path)); return; }
      const status = await window.api.previewStatus(active.path);
      if (activePathRef.current !== active.path) return; // já trocou de novo
      if (status.running && status.url) { showWebFor(active.path, status.url); return; }
      if (!active.hasPkg) { setMode('empty'); return; }

      setMode('log');
      setTimeout(async () => {
        if (activePathRef.current !== active.path) return;
        if (logRef.current) logRef.current.textContent = '';
        if (status.running && !status.url) {
          const log = await window.api.previewGetLog(active.path);
          if (log) appendLog(active.path, log);
          appendLog(active.path, t('preview.log_found'));
          return;
        }
        appendLog(active.path, t('preview.log_preparing'));
        const res = await window.api.startPreview(active.path);
        if (res && res.error) appendLog(active.path, '\n[erro] ' + res.error + '\n');
        onProjectsChanged?.();
      }, 0);
    })();
  }, [active, showWebFor, appendLog, onProjectsChanged]);

  // Navega o preview do projeto ativo até `v` (garante http://, troca pra aba
  // Preview e aponta o webview). Caminho único usado tanto pela barra de URL
  // quanto pelo Ctrl+clique num link do terminal.
  const navigateTo = useCallback((v) => {
    if (!active) return;
    v = (v || '').trim();
    if (!v) return;
    if (!/^https?:\/\//i.test(v)) v = 'http://' + v;
    setView('preview');
    showWebFor(active.path, v);
  }, [active, showWebFor]);

  const onUrlKey = (e) => {
    if (e.key !== 'Enter') return;
    navigateTo(url);
    e.target.blur();
  };

  const reload = () => { if (active) { try { webviewsRef.current.get(active.path)?.reload(); } catch {} } };
  // Abre o preview atual no navegador padrão do sistema. Sem lock-in: se a pessoa
  // preferir o navegador dela (DevTools próprio, extensões, etc.), é só um clique.
  const openInBrowser = () => { if (mode === 'web' && url) window.api.openExternal(url); };
  // Trava contra clique repetido: parar/reiniciar mexem no mesmo servidor, então
  // enquanto uma operação está rodando, as outras são ignoradas. Por mais que
  // cliquem 10x num segundo, só a primeira vale; as demais voltam na hora. É um
  // lock por operação (não um timer), então libera assim que a ação termina.
  const serverBusyRef = useRef(false);
  const stop = async () => {
    if (!active || serverBusyRef.current) return;
    serverBusyRef.current = true;
    manualStopRef.current.add(active.path); // pra o preview:exit cair no empty state, não no log
    try {
      await window.api.stopPreview(active.path);
      urlsRef.current.delete(active.path);
      const w = webviewsRef.current.get(active.path);
      if (w) { w.remove(); webviewsRef.current.delete(active.path); }
      setMode('empty');
    } finally {
      serverBusyRef.current = false;
    }
  };
  const restart = async () => {
    if (!active || serverBusyRef.current) return;
    serverBusyRef.current = true;
    manualStopRef.current.delete(active.path); // reiniciar não é parada manual: deixa o fluxo normal (log)
    await window.api.stopPreview(active.path);
    urlsRef.current.delete(active.path);
    const w = webviewsRef.current.get(active.path);
    if (w) { w.remove(); webviewsRef.current.delete(active.path); }
    setMode('log');
    setTimeout(async () => {
      try {
        if (logRef.current) logRef.current.textContent = '';
        appendLog(active.path, t('preview.log_restarting'));
        const res = await window.api.startPreview(active.path);
        if (res && res.error) appendLog(active.path, '\n[erro] ' + res.error + '\n');
        onProjectsChanged?.();
      } finally {
        serverBusyRef.current = false;
      }
    }, 0);
  };

  // Expõe parar/reiniciar pro cabeçalho (App.jsx), que mora na outra coluna. O ref
  // é reatribuído a cada render pra sempre apontar pros closures atuais; o `mode`
  // é reportado pra o cabeçalho saber habilitar/desabilitar os botões.
  // Abre um arquivo na aba "Código" (vindo da paleta de comandos). O `seq` força o
  // CodeView a reagir mesmo quando o mesmo arquivo é pedido duas vezes seguidas.
  const openFile = useCallback((file) => {
    if (!file?.path) return;
    openSeqRef.current += 1;
    setOpenRequest({ path: file.path, name: file.name, seq: openSeqRef.current });
    setView('code');
  }, []);

  if (controlsRef) controlsRef.current = { stop, restart, setView, openFile };
  useEffect(() => { onModeChange?.(mode); }, [mode, onModeChange]);

  // Arrasta a borda superior do terminal pra redimensionar (estilo VS Code).
  const startResize = (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = termHeight;
    setTermDragging(true); // camada por cima do webview pra ele não engolir o arraste
    const onMove = (ev) => {
      const h = Math.max(120, Math.min(startH + (startY - ev.clientY), window.innerHeight - 180));
      setTermHeight(h);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      setTermDragging(false);
    };
    document.body.style.cursor = 'row-resize';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const copyClaudePrompt = async () => {
    if (!active) return;
    const prompt = [
      t('preview.claude_prompt_1', { projectName: active.name }),
      t('preview.claude_prompt_2'),
      t('preview.claude_prompt_3'),
      t('preview.claude_prompt_4'),
      t('preview.claude_prompt_5'),
      t('preview.claude_prompt_6'),
      t('preview.claude_prompt_7'),
      t('preview.claude_prompt_8'),
    ].join('\n');
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  const inPreview = view === 'preview';
  const inCode = view === 'code';
  const inGit = view === 'git';
  const inApi = view === 'api';
  const inMcp = view === 'mcp';
  const inBoard = view === 'board';
  const inHistory = view === 'history';

  return (
    <>
      {active && (
      <div className="relative z-10 flex h-12 shrink-0 items-center gap-2 border-b bg-card px-2.5">
        <Tabs value={view} onValueChange={setView}>
          <TabsList className="h-8 gap-0.5 p-0.5">
            <TabsTrigger value="preview" className="h-7 gap-1.5 px-2.5 text-[13px] [&_svg]:size-[15px]"><HoverIcon as={EarthIcon} />{t('preview.tab')}</TabsTrigger>
            <TabsTrigger value="code" className="h-7 gap-1.5 px-2.5 text-[13px] [&_svg]:size-[15px]"><HoverIcon as={ChevronsLeftRightIcon} />{t('preview.code')}</TabsTrigger>
            <TabsTrigger value="git" className="h-7 gap-1.5 px-2.5 text-[13px] [&_svg]:size-[15px]"><HoverIcon as={GitBranchIcon} />{t('preview.git')}</TabsTrigger>
          </TabsList>
        </Tabs>

        {/* Ferramentas menos usadas (API, MCP) num menu com seta, pra enxugar a barra. */}
        <MoreTools view={view} onPick={setView} />

        {inPreview && (
          <>
            {/* Voltar/avançar, estilo navegador. */}
            <div className="flex items-center gap-0.5">
              <ToolButton onClick={goBack} disabled={!canBack} title={t('preview.back')}><ArrowLeftIcon /></ToolButton>
              <ToolButton onClick={goFwd} disabled={!canFwd} title={t('preview.forward')}><ArrowRightIcon /></ToolButton>
            </div>
            {/* Barra de URL com o "recarregar" embutido, estilo navegador. */}
            <div className="relative flex-1">
              <button
                type="button"
                onClick={reload}
                disabled={mode !== 'web'}
                title={t('preview.reload')}
                className="absolute left-1 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-[14px]"
              >
                <RotateCWIcon />
              </button>
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={onUrlKey}
                spellCheck={false}
                placeholder={t('preview.url_placeholder')}
                className="h-8 pl-8 pr-8 font-mono text-xs"
              />
              <button
                type="button"
                onClick={openInBrowser}
                disabled={mode !== 'web'}
                title={t('preview.open_browser')}
                className="absolute right-1 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-[14px]"
              >
                <ExternalLink />
              </button>
            </div>

            <div className="flex items-center gap-0.5">
              <ToolButton onClick={toggleGrab} disabled={mode !== 'web'} active={grabbing} title={t('preview.grab_element')}><Crosshair /></ToolButton>
              <ToolButton onClick={toggleDevtools} disabled={mode !== 'web'} active={devtoolsOpen} title={t('preview.devtools')}><Bug /></ToolButton>
            </div>
            <div className="h-5 w-px bg-border" />
          </>
        )}

        {(inCode || inGit || inApi || inMcp || inBoard) && <div className="flex-1" />}

        <ToolButton
          onClick={() => setTermOpen((o) => !o)}
          disabled={!active}
          active={termOpen}
          title={termOpen ? t('preview.close_terminal') : t('preview.open_terminal')}
        >
          <TerminalIcon />
        </ToolButton>
      </div>
      )}

      <div ref={bodyRowRef} className="relative flex min-h-0 min-w-0 flex-1">
        <div className="relative isolate min-h-0 min-w-0 flex-1">
          <div ref={containerRef} className={cn('absolute inset-0', !inPreview && 'pointer-events-none')} />
          {/* Borda discreta: foco está dentro do preview → Ctrl +/- zooma o site, não o app. */}
          {inPreview && mode === 'web' && webFocused && (
            <div className="pointer-events-none absolute inset-0 z-10 ring-2 ring-inset ring-primary/40" />
          )}
          {inPreview && (grabbing || grabbed) && (
            <div className="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center">
              <div className={cn('rounded-full border px-3 py-1.5 text-xs font-medium shadow-md', grabbed ? 'border-primary/40 bg-primary text-primary-foreground' : 'bg-popover text-popover-foreground')}>
                {grabbed ? t('preview.grab_done') : t('preview.grab_active')}
              </div>
            </div>
          )}
          {inPreview && mode === 'log' && (
            <pre
              ref={logRef}
              className="absolute inset-0 m-0 overflow-auto whitespace-pre-wrap break-words bg-background p-3.5 font-mono text-xs leading-relaxed text-muted-foreground"
            />
          )}
          {inPreview && mode === 'empty' && (
            active ? (
              <div className="absolute inset-0">
                <EmptyState>
                  {active.hasPkg
                    ? t('preview.no_preview')
                    : t('preview.no_preview_server')}
                  <Button variant="secondary" size="sm" onClick={copyClaudePrompt} className="mt-1">
                    <Copy className="mr-1" />{copied ? t('preview.prompt_copied') : t('preview.copy_prompt')}
                  </Button>
                </EmptyState>
              </div>
            ) : (
              <div className="absolute inset-0">
                <EmptyState size="lg">{t('preview.select_project')}</EmptyState>
              </div>
            )
          )}
          {inCode && <LazyPanel label="Código"><CodeView active={active} openRequest={openRequest} /></LazyPanel>}
          {inHistory && <LazyPanel label="Histórico"><CheckpointsPanel active={active} visible={inHistory} /></LazyPanel>}
          {inGit && <LazyPanel label="Git"><GitPanel active={active} visible={inGit} /></LazyPanel>}
          {inApi && <LazyPanel label="API"><ApiPanel key={active?.path || 'none'} active={active} /></LazyPanel>}
          {inMcp && <LazyPanel label="MCP"><MCPPanel active={active} /></LazyPanel>}
          {inBoard && <LazyPanel label="Quadro"><TldrawPanel active={active} /></LazyPanel>}
        </div>

        {/* Alça pra redimensionar o painel de DevTools. */}
        {devtoolsOpen && inPreview && <ResizeBar onMouseDown={startDevtoolsResize} />}

        {/* Painel do DevTools (à direita). O webview vive sempre aqui; só fica escondido quando fechado. */}
        <div
          className={cn('relative min-h-0 shrink-0', !(devtoolsOpen && inPreview) && 'w-0 overflow-hidden')}
          style={devtoolsOpen && inPreview ? { width: devtoolsWidth } : undefined}
        >
          <div ref={devtoolsHostRef} className="absolute inset-0 bg-card" />
        </div>

        {/* Camada que captura o mouse durante o arraste (senão o webview "engole" o evento). */}
        {dtDragging && <div className="fixed inset-0 z-50 cursor-col-resize" />}
      </div>

      {termOpen && (
        <div className="flex shrink-0 flex-col" style={{ height: termHeight }}>
          <DragHandle onMouseDown={startResize} />
          <div className="flex h-8 shrink-0 items-center gap-2 border-b bg-card px-2.5 text-xs text-muted-foreground">
            <Terminal className="h-3.5 w-3.5" />
            <span className="truncate font-medium">{active ? t('preview.terminal_label', { projectName: active.name }) : t('preview.terminal_bare')}</span>
            <div className="flex-1" />
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setTermOpen(false)} title={t('preview.close_terminal')}>
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
          <div className="relative min-h-0 flex-1">
            <LazyPanel label="Terminal">
              <ShellView activeProject={active?.path || null} visible={termOpen} onOpenUrl={navigateTo} />
            </LazyPanel>
          </div>
        </div>
      )}

      {/* Captura o mouse durante o arraste do terminal (senão o webview engole o evento). */}
      {termDragging && <div className="fixed inset-0 z-50 cursor-row-resize" />}
    </>
  );
}
