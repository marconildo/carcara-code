import { useCallback, useEffect, useState } from 'react';
import { Check, Download, RefreshCw, GitBranch, Hexagon, Loader2 } from 'lucide-react';
import { Button } from './ui/button.jsx';

// Ferramentas externas que o Carcará usa. O app abre sem elas (o Electron traz o próprio
// runtime) e a gente só guia a instalação — sem instalar nada escondido, sem pedir admin.
// Nota: o CLI de IA (Claude Code, Codex, OpenCode, Antigravity…) NÃO entra aqui — cada um
// instala o seu, e nem todo mundo usa o Claude. Aqui ficam só as dependências comuns a todos.
const LEVELS = {
  essential: { label: 'Essencial', cls: 'bg-primary/10 text-primary' },
  recommended: { label: 'Recomendado', cls: 'bg-amber-500/10 text-amber-600 dark:text-amber-400' },
};

export const DEPENDENCIES = [
  {
    key: 'node',
    name: 'Node.js',
    Icon: Hexagon,
    level: 'essential',
    desc: 'Faz o Preview funcionar — ver o projeto rodando ao vivo é o coração do Carcará. Sem Node, sem Preview.',
    note: 'Baixe a versão LTS.',
    url: 'https://nodejs.org/en/download',
  },
  {
    key: 'git',
    name: 'Git',
    Icon: GitBranch,
    level: 'recommended',
    desc: 'Usado pela aba Git (commits, branches, GitHub) e pela ferramenta Bash do Claude. Sem ele, o Claude cai no PowerShell.',
    url: 'https://git-scm.com/download/win',
  },
];

function StatusPill({ state }) {
  if (state === 'loading') {
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" /> verificando…
      </span>
    );
  }
  if (state === true) {
    return (
      <span className="flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
        <Check className="size-3.5" /> Instalado
      </span>
    );
  }
  return (
    <span className="rounded-full bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-600 dark:text-amber-400">
      Não encontrado
    </span>
  );
}

// Hook compartilhado: detecta as ferramentas (sem cache) quando 'active' liga, e diz se as
// essenciais estão prontas. Usado pela tela de preparo (1º uso) e pela aba Dependências.
export function useDependencyStatus(active) {
  const [status, setStatus] = useState(null); // { git, node, npm, claude } | null
  const [loading, setLoading] = useState(false);

  const check = useCallback(async () => {
    setLoading(true);
    try {
      const r = await window.api.checkTools();
      if (r?.ok) setStatus(r);
    } catch { /* ignora: a tela mostra "não encontrado" e o botão de baixar */ }
    setLoading(false);
  }, []);

  useEffect(() => { if (active) check(); }, [active, check]);

  const essentialsReady = !!status && DEPENDENCIES
    .filter((t) => t.level === 'essential')
    .every((t) => status[t.key]);

  return { status, loading, check, essentialsReady };
}

// Lista visual dos cartões de dependência (compartilhada pela tela de preparo e pelas Configurações).
export function DependencyCards({ status, loading }) {
  const stateOf = (key) => (loading && !status ? 'loading' : status ? !!status[key] : false);
  return (
    <div className="flex flex-col gap-3">
      {DEPENDENCIES.map((t) => {
        const st = stateOf(t.key);
        const installed = st === true;
        const lvl = LEVELS[t.level];
        return (
          <div key={t.key}
            className={'flex items-start gap-3.5 rounded-xl border p-4 transition-colors ' + (installed ? 'border-emerald-500/30 bg-emerald-500/[0.03]' : '')}>
            <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-foreground">
              <t.Icon className="size-[18px]" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[15px] font-medium">{t.name}</span>
                <span className={'rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ' + lvl.cls}>{lvl.label}</span>
                <StatusPill state={st} />
              </div>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t.desc}</p>
              {t.note && !installed && (
                <p className="mt-1.5 rounded-md bg-muted/60 px-2 py-1 font-mono text-[11px] leading-relaxed text-foreground/80">{t.note}</p>
              )}
            </div>
            {!installed && (
              <Button size="sm" variant="secondary" className="shrink-0 gap-1.5"
                onClick={() => window.api.openExternal(t.url)}>
                <Download className="size-3.5" /> Instalar
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function SetupScreen({ open, onClose }) {
  const { status, loading, check, essentialsReady } = useDependencyStatus(open);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex flex-col overflow-y-auto bg-background">
      <div className="mx-auto w-full max-w-2xl px-6 py-12">
        <div className="eyebrow text-primary">Primeiro uso</div>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Vamos preparar seu PC</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          O Carcará abre sozinho, mas ele trabalha em cima de algumas ferramentas que ficam no seu
          computador. Confira o que já está pronto e instale o que faltar — é uma vez só.
        </p>

        <div className="mt-7">
          <DependencyCards status={status} loading={loading} />
        </div>

        <div className="mt-6 flex items-center gap-2">
          <Button variant="outline" size="sm" className="gap-1.5" disabled={loading} onClick={check}>
            <RefreshCw className={'size-3.5 ' + (loading ? 'animate-spin' : '')} /> Verificar de novo
          </Button>
          <div className="flex-1" />
          <Button size="sm" onClick={onClose}>
            {essentialsReady ? 'Tudo pronto — entrar' : 'Continuar mesmo assim'}
          </Button>
        </div>

        <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
          Pode entrar e instalar o resto quando quiser. Acabou de instalar algo? Clique em
          “Verificar de novo”. Esta tela não volta mais sozinha — pra checar de novo, vá em
          Configurações → Dependências (ou Ctrl/Cmd+K → “Preparar meu PC”).
        </p>
      </div>
    </div>
  );
}
