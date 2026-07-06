# Spec — "Corrigir com Claude" (captura de erros do preview)

**Data:** 2026-07-06
**Status:** aprovado (aguardando revisão do spec escrito)
**Sub-projeto #1** de um conjunto maior (perfil vibecoder×dev, edição visual inline etc. ficam
para ciclos próprios).

## Objetivo

Quando o preview quebra — erro de **runtime** (exceção não capturada, promise rejeitada, tela
branca) ou erro de **build** do dev server (sintaxe/compilação) — mostrar um aviso discreto no
canto do preview. Um clique empacota o erro e injeta no input da sessão Claude ativa, pronto
para o usuário revisar e dar Enter.

Inspiração: o "Attempt Fix" do Bolt.new, mas **manual por padrão** (o usuário decide), adequado
ao público vibecoder do Carcará.

## Princípios / decisões já tomadas

- **Manual, não automático.** Nada é enviado sem clique. Sem auto-fix, sem loop.
- **Injeta e espera Enter.** O clique cola o pacote no input da sessão e foca; o usuário revisa
  e envia. Não auto-submete.
- **Núcleo de alto sinal.** Só runtime + build. Fora: `console.error`, erros de rede, screenshot.
- **Efêmero.** Erros não persistem; zeram em reload ok / build ok / troca de projeto.
- **Sempre ligado nesta versão.** O toggle de ligar/desligar entra no futuro sub-projeto "Perfil".

## Arquitetura

### 1. Detecção (duas fontes, ambas já têm gancho no código)

**Runtime** — script minúsculo injetado no `dom-ready` do webview (mesmo padrão do `NAV_INJECT`
existente em `PreviewPanel.jsx`). Engancha `window.onerror` e `window.onunhandledrejection` e
emite uma **sentinela via console** (`__YGC_ERR__` + JSON com `{message, stack, url}`).
Reaproveita **exatamente** a ponte `console-message` que o element-grab já usa
(`PreviewPanel.jsx:608`). Preserva qualquer handler pré-existente da página (encadeia, não
sobrescreve).

**Tela branca / página não carrega** — o handler `did-fail-load` já existe
(`PreviewPanel.jsx:583`). Quando `errorCode !== -3` (abort) e a falha for real, vira um entry
`{message: 'Falha ao carregar a página', url, errorCode}`.

**Build do dev server** — erros de sintaxe/compilação já chegam no renderer via `preview:log`
(stderr, `PreviewPanel.jsx:1041`). Uma função pura classifica o chunk como erro e extrai
`arquivo:linha`.

### 2. Unidade isolável e testável — `src/lib/previewErrors.js` (novo)

Módulo **puro** (sem `fs`, sem React). API:

```
parseBuildError(chunk: string) -> { message, file, line } | null
parseRuntimeStack(stack: string) -> { file, line } | null   // best-effort
```

- `parseBuildError` reconhece os formatos comuns de stderr de dev server (Vite, Next):
  linhas com `Error`/`SyntaxError`/`Failed to compile` e o padrão `caminho:linha:coluna`.
  Retorna `null` para chunks que não são erro (log normal), para não gerar falso positivo.
- `parseRuntimeStack` extrai `file:line` da primeira frame útil do stack (ignora
  `node_modules`/URLs de bundle quando possível). Best-effort: pode devolver `null`.

Testável por amostras — smoke script em `scripts/` (espírito do `platform-smoke.cjs`), com
exemplos reais de stderr de Vite/Next e de stacks de runtime.

### 3. Estado + UI (no PreviewPanel)

- Estado `errors` **por projeto ativo**. Dedupe por chave `(message + file:line)`: erro repetido
  incrementa uma contagem, não empilha.
- Quando `errors.length > 0` **e** `view === 'preview'`: um _pill_ discreto num canto do preview:
  `⚠ N erro(s) — Corrigir com Claude`, com botão de ação e um `×` para dispensar.
- **Reset (zera o estado):** reload bem-sucedido (`did-finish-load` após falha), primeiro
  `preview:log` de build OK após erro, troca de projeto, `preview:exit`.
- Não aparece em outras views (code/git/todos/etc.) — é um sinal do preview.

### 4. Empacotar + enviar

Ao clicar em "Corrigir com Claude", monta markdown:

````
Corrija este erro do preview:

**Erro:** <message>
**Rota:** <url/rota atual>
**Arquivo:** <file>:<line>   (linha omitida quando não houver)

​```
<stack do runtime  /  stderr do build>
​```
````

Envio pela ponte nova (ver 5). Injeta no input da sessão em foco e foca o terminal — **o usuário
dá Enter**. Se não houver sessão aberta, cria uma (`newSession`) e injeta.

Se vários erros estiverem agrupados, envia o **mais recente** (o pill mostra a contagem; v1 não
manda lote).

### 5. Ponte `chatControls`

Hoje `ChatPanel` expõe só `{ newSession }` em `controlsRef.current` (`ChatPanel.jsx:1089`).
Expandir para:

```
controlsRef.current = {
  newSession,
  sendToActiveSession(text)   // resolve pane/sessão em foco; se não houver, cria; usa insertText
}
```

`sendToActiveSession` reaproveita `insertText(sid, text)` (bracketed paste,
`ChatPanel.jsx:1059`) — texto multi-linha vai inteiro, sem cada `\n` virar Enter.

### 6. Ligação no App

`App.jsx` já mantém `chatControls` (ref) e passa `previewControls` ao `PreviewPanel`. Adicionar
prop `onSendToClaude={(text) => chatControls.current?.sendToActiveSession?.(text)}` ao
`PreviewPanel`. O PreviewPanel chama essa prop no clique do pill.

### 7. i18n

Chaves novas pt/en em `src/lib/i18n.jsx`:

- `preview.errorPill` (com `{n}`), `preview.errorFix` (rótulo do botão),
  `preview.errorDismiss` (título do ×).
- `preview.errorTemplateIntro` e rótulos `Erro:/Rota:/Arquivo:` do pacote (ou montar o markdown
  com strings traduzíveis).

## Arquivos tocados

| Arquivo                                   | Mudança                                                                                                                                             |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/previewErrors.js` (novo)         | parser puro stderr/stack → `{message,file,line}`                                                                                                    |
| `scripts/preview-errors-smoke.cjs` (novo) | smoke test do parser com amostras                                                                                                                   |
| `src/components/PreviewPanel.jsx`         | script runtime injetado, sentinela no `console-message`, classificar `preview:log`, entry no `did-fail-load`, estado `errors`, pill + botão, resets |
| `src/components/ChatPanel.jsx`            | expor `sendToActiveSession(text)` no `controlsRef`                                                                                                  |
| `src/App.jsx`                             | prop `onSendToClaude` no `PreviewPanel` ligada a `chatControls`                                                                                     |
| `src/lib/i18n.jsx`                        | chaves pt/en do pill e do template                                                                                                                  |

## Tratamento de erros / casos de borda

- **Dedupe** por `(message+file:line)` — evita spam de erro repetido.
- **Reset** claro (ver 3) — o pill não fica "preso" após o usuário consertar.
- **Sem sessão Claude** → cria uma e injeta.
- **Runtime sem stack útil** (extensões, terceiros) → `parseRuntimeStack` devolve `null`; o
  pacote sai sem `Arquivo:` mas ainda com mensagem+stack.
- **Falso positivo de build** → `parseBuildError` retorna `null` para chunks que não casam os
  padrões de erro; preferir perder um erro raro a poluir com log normal.
- **`did-fail-load` com `errorCode === -3`** → ignorado (navegação abortada, não é falha).

## Fora de escopo (YAGNI)

Screenshot do preview; captura de `console.error`; erros de rede (4xx/5xx); aba/painel dedicado
de erros; auto-fix automático; histórico persistido de erros; envio em lote de múltiplos erros;
toggle de ligar/desligar (vem no sub-projeto "Perfil").

## Plano de testes

- **Unit/smoke** (`previewErrors`): amostras reais de stderr Vite/Next e de stacks de runtime →
  confere `message`/`file`/`line` extraídos, e `null` para não-erros.
- **Manual:** `throw` num componente do preview → pill aparece → clica → injeção na sessão ativa;
  quebrar sintaxe de um arquivo → erro de build no pill; corrigir → pill some no build ok.

## Plataforma

Nada específico de SO. Não introduzir `process.platform` fora de `platform.cjs`.
