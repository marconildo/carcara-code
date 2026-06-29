# Visualizador de HTML inline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar um botão de olhinho no CodeView que, com um `.html` aberto, troca o editor de código pela página renderizada (via `<webview>` apontando pro arquivo no disco), salvando antes de visualizar.

**Architecture:** Espelha o mecanismo já existente do preview de Markdown no [CodeView.jsx](../../../src/components/CodeView.jsx), mas com o padrão de abertura invertido (HTML abre como código; olhinho leva pra visualização). A renderização usa `<webview src="file://…">` — o Chromium embutido do Electron — pra que CSS/JS/imagens relativos funcionem igual ao navegador, sem Chrome instalado. Helpers puros (`isHtml`, `fileUrlFor`) vão pra um módulo testável em `src/lib`, seguindo o padrão de `src/lib/layout.js`.

**Tech Stack:** React, Electron (`webviewTag` já ligado), Vite, Vitest, i18n via `useT()` com `src/lib/locales/{pt,en}.json`.

## Global Constraints

- App é Electron com `contextIsolation: true`, `nodeIntegration: false`, `webviewTag: true` ([main.js](../../../main.js) `webPreferences`). Nada de Node no renderer; I/O passa por `window.api` (preload).
- Edições em `src/` só aparecem após `npm run build` (o app carrega `dist/`). Nunca forçar relançamento do app — ele pode ter uma sessão do Claude rodando; só buildar e avisar.
- Toda chave nova de i18n DEVE existir em pt.json **e** en.json (paridade verificada por `npm run test:i18n`).
- Strings de UI sempre via `t('…')`, nunca hardcoded.
- Comentários/commits no estilo do repo (português).

---

### Task 1: Helpers puros `isHtml` e `fileUrlFor`

Lógica pura e testável: detectar arquivos HTML e converter um caminho absoluto (Windows) numa URL `file://` com encoding correto. Extraída pra `src/lib` pra poder ter teste unitário, igual `layout.js`.

**Files:**
- Create: `src/lib/htmlPreview.js`
- Test: `src/lib/htmlPreview.test.js`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `isHtml(name: string): boolean` — `true` pra extensões `html`, `htm`, `xhtml` (case-insensitive).
  - `fileUrlFor(path: string): string` — caminho absoluto → URL `file:///…`, barras normalizadas pra `/`, espaços e caracteres especiais codificados.

- [ ] **Step 1: Escrever os testes que falham**

Create `src/lib/htmlPreview.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { isHtml, fileUrlFor } from './htmlPreview.js';

describe('isHtml', () => {
  it('reconhece .html, .htm e .xhtml (case-insensitive)', () => {
    expect(isHtml('index.html')).toBe(true);
    expect(isHtml('page.HTM')).toBe(true);
    expect(isHtml('doc.xhtml')).toBe(true);
  });

  it('rejeita outras extensões', () => {
    expect(isHtml('readme.md')).toBe(false);
    expect(isHtml('app.js')).toBe(false);
    expect(isHtml('styles.css')).toBe(false);
    expect(isHtml('semponto')).toBe(false);
  });

  it('não quebra com valor vazio/nulo', () => {
    expect(isHtml('')).toBe(false);
    expect(isHtml(null)).toBe(false);
  });
});

describe('fileUrlFor', () => {
  it('converte caminho Windows com barras invertidas', () => {
    expect(fileUrlFor('C:\\Users\\x\\page.html')).toBe('file:///C:/Users/x/page.html');
  });

  it('codifica espaços no caminho', () => {
    expect(fileUrlFor('C:\\Users\\Ygor Andrade\\a b.html'))
      .toBe('file:///C:/Users/Ygor%20Andrade/a%20b.html');
  });

  it('aceita caminho que já usa barras normais', () => {
    expect(fileUrlFor('C:/foo/bar.html')).toBe('file:///C:/foo/bar.html');
  });

  it('codifica # e ? no nome do arquivo', () => {
    expect(fileUrlFor('C:/a/p#1.html')).toBe('file:///C:/a/p%231.html');
    expect(fileUrlFor('C:/a/q?x.html')).toBe('file:///C:/a/q%3Fx.html');
  });

  it('não quebra com valor vazio/nulo', () => {
    expect(fileUrlFor(null)).toBe('file:///');
    expect(fileUrlFor('')).toBe('file:///');
  });
});
```

- [ ] **Step 2: Rodar os testes pra confirmar que falham**

Run: `npx vitest run src/lib/htmlPreview.test.js`
Expected: FAIL — `Failed to resolve import "./htmlPreview.js"` / `isHtml is not a function`.

- [ ] **Step 3: Implementar o módulo**

Create `src/lib/htmlPreview.js`:

```js
// Helpers puros do visualizador de HTML inline (testáveis sem React/Electron).

// Arquivos que o visualizador trata como página renderizável.
export function isHtml(name) {
  const e = String(name || '').toLowerCase().split('.').pop();
  return ['html', 'htm', 'xhtml'].includes(e);
}

// Caminho absoluto -> URL file:// pro <webview>. Normaliza barras do Windows,
// tira barras iniciais (pra não duplicar em file:///), e codifica espaços e
// caracteres que quebrariam a URL. encodeURI preserva ':' e '/', mas deixa
// '#' e '?' passarem — por isso a troca explícita desses dois.
export function fileUrlFor(path) {
  const norm = String(path || '').replace(/\\/g, '/').replace(/^\/+/, '');
  return 'file:///' + encodeURI(norm).replace(/#/g, '%23').replace(/\?/g, '%3F');
}
```

- [ ] **Step 4: Rodar os testes pra confirmar que passam**

Run: `npx vitest run src/lib/htmlPreview.test.js`
Expected: PASS — todos os casos verdes.

- [ ] **Step 5: Commit**

```bash
git add src/lib/htmlPreview.js src/lib/htmlPreview.test.js
git commit -m "feat(html): helpers isHtml e fileUrlFor com testes"
```

---

### Task 2: Chaves de i18n do botão

Adiciona os textos do botão/tooltips em pt e en, espelhando as chaves do Markdown (`md_button_*`, `md_toggle_*`), mantendo paridade.

**Files:**
- Modify: `src/lib/locales/pt.json` (grupo `code`, após `md_button_preview`, linha ~152)
- Modify: `src/lib/locales/en.json` (grupo `code`, após `md_button_preview`, linha ~152)

**Interfaces:**
- Produces (chaves usadas na Task 3):
  - `code.html_button_preview`, `code.html_button_edit` — rótulos do botão.
  - `code.html_toggle_preview`, `code.html_toggle_edit` — tooltips (`title`).

- [ ] **Step 1: Adicionar as chaves no pt.json**

Em `src/lib/locales/pt.json`, no grupo `"code"`, logo depois da linha `"md_button_preview": "Visualizar",` adicione:

```json
    "html_toggle_edit": "Voltar ao código",
    "html_toggle_preview": "Visualizar renderizado",
    "html_button_edit": "Código",
    "html_button_preview": "Visualizar",
```

- [ ] **Step 2: Adicionar as chaves no en.json**

Em `src/lib/locales/en.json`, no grupo `"code"`, logo depois da linha `"md_button_preview": "Preview",` adicione:

```json
    "html_toggle_edit": "Back to code",
    "html_toggle_preview": "View rendered",
    "html_button_edit": "Code",
    "html_button_preview": "Preview",
```

- [ ] **Step 3: Rodar o smoke de paridade de i18n**

Run: `npm run test:i18n`
Expected: PASS — sem chaves faltando entre pt e en (as 4 novas existem nos dois).

- [ ] **Step 4: Commit**

```bash
git add src/lib/locales/pt.json src/lib/locales/en.json
git commit -m "feat(i18n): textos do botão de visualizar HTML"
```

---

### Task 3: Componente `HtmlViewer` (webview)

Componente enxuto que monta um `<webview>` ocupando a área, apontando pro arquivo no disco via `fileUrlFor`. Sem partition/grab/devtools — só visualizar. Lazy, como `XlsxViewer`, pra não pesar o boot.

**Files:**
- Create: `src/components/HtmlViewer.jsx`

**Interfaces:**
- Consumes: `fileUrlFor(path)` da Task 1.
- Produces: `export default function HtmlViewer({ path })` — renderiza o HTML de `path`. Recria o webview quando `path` muda.

- [ ] **Step 1: Criar o componente**

Create `src/components/HtmlViewer.jsx`:

```jsx
// Visualizador read-only de HTML: monta um <webview> (Chromium embutido do
// Electron) apontando pro arquivo no disco via file://, pra que CSS/JS/imagens
// relativos resolvam igual ao navegador — e sem precisar de navegador instalado.
// Carregado sob demanda (React.lazy) pelo CodeView.
import { useEffect, useRef } from 'react';
import { fileUrlFor } from '@/lib/htmlPreview';

export default function HtmlViewer({ path }) {
  const hostRef = useRef(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !path) return;
    // <webview> não é um elemento React nativo bem comportado; cria via DOM, igual
    // o PreviewPanel. Sem partition: usa a sessão padrão, sem Node, read-only.
    const w = document.createElement('webview');
    w.setAttribute('src', fileUrlFor(path));
    w.style.position = 'absolute';
    w.style.inset = '0';
    w.style.width = '100%';
    w.style.height = '100%';
    w.style.background = '#fff';
    host.appendChild(w);
    return () => { try { w.remove(); } catch {} };
  }, [path]);
  return <div ref={hostRef} className="absolute inset-0 bg-white" />;
}
```

- [ ] **Step 2: Verificar que compila (build)**

Run: `npm run build`
Expected: build conclui sem erro; aparece um chunk novo `HtmlViewer-*.js` na saída do Vite.

- [ ] **Step 3: Commit**

```bash
git add src/components/HtmlViewer.jsx
git commit -m "feat(html): componente HtmlViewer (webview file://)"
```

---

### Task 4: Ligar o botão e o preview no CodeView

Importa o helper e o componente, adiciona o estado de preview por aba (espelhando `mdEdit`), o toggle assíncrono que salva antes de visualizar, o botão na barra de abas e o ramo de renderização.

**Files:**
- Modify: `src/components/CodeView.jsx` (imports ~5-49; estado ~200-206; botão ~784-789; ramo de render ~809-824)

**Interfaces:**
- Consumes: `isHtml` e `fileUrlFor` (Task 1), `HtmlViewer` default (Task 3), chaves `code.html_*` (Task 2).
- Produces: comportamento de UI; nada consumido por outras tasks.

- [ ] **Step 1: Importar helper e componente lazy**

Em `src/components/CodeView.jsx`, junto dos outros lazy (logo após a linha `const XlsxViewer = lazy(() => import('./XlsxViewer.jsx'));`, ~linha 49), adicione:

```jsx
// Visualizador read-only de HTML (webview), sob demanda.
const HtmlViewer = lazy(() => import('./HtmlViewer.jsx'));
```

E no topo, junto dos imports de libs (após a linha `import { useT } from '@/lib/i18n';`, ~linha 44), adicione:

```jsx
import { isHtml } from '@/lib/htmlPreview';
```

- [ ] **Step 2: Remover o `isMarkdown` local duplicado? Não — manter.**

Nada a fazer aqui: `isMarkdown` continua como está (linhas ~51-54). Só confirme que `isHtml` agora vem do import e NÃO existe uma definição local conflitante de `isHtml` no arquivo (não deve existir).

- [ ] **Step 3: Adicionar o estado de preview de HTML**

Em `CodeView`, logo após o bloco do `mdEdit`/`toggleMdEdit` (após a linha que fecha `toggleMdEdit` com `});`, ~linha 206), adicione:

```jsx
  // .html abertos em modo PREVIEW (renderizado). Padrão é código; este set marca
  // quem está em visualização. Por path, pra preservar ao alternar abas.
  const [htmlPreview, setHtmlPreview] = useState(() => new Set());
  const htmlShown = activeTab && isHtml(activeTab.name) && htmlPreview.has(activeTab.path);
  // Entrar em preview salva a aba se estiver suja (o webview lê do disco); sair só volta.
  const toggleHtmlPreview = async () => {
    if (!activeTab) return;
    const path = activeTab.path;
    if (htmlPreview.has(path)) {
      setHtmlPreview((s) => { const n = new Set(s); n.delete(path); return n; });
      return;
    }
    if (activeTab.dirty && !activeTab.notice) {
      const res = await window.api.writeFile(path, activeTab.content);
      if (res.error) return; // falhou ao salvar: não entra em preview
      setTabs((cur) => cur.map((x) => (x.path === path ? { ...x, dirty: false } : x)));
    }
    setHtmlPreview((s) => { const n = new Set(s); n.add(path); return n; });
  };
```

- [ ] **Step 4: Adicionar o botão na barra de abas**

Logo após o bloco do botão do Markdown (o `{activeTab && … isMarkdown(activeTab.name) && ( … )}`, que termina ~linha 789), adicione:

```jsx
              {activeTab && !activeTab.notice && !activeTab.image && !activeTab.pdf && !activeTab.xlsx && isHtml(activeTab.name) && (
                <Button variant="ghost" size="sm" className="h-7 shrink-0 gap-1.5 text-muted-foreground" onClick={toggleHtmlPreview}
                  title={htmlShown ? t('code.html_toggle_edit') : t('code.html_toggle_preview')}>
                  {htmlShown ? <><Code2 className="size-3.5" />{t('code.html_button_edit')}</> : <><Eye className="size-3.5" />{t('code.html_button_preview')}</>}
                </Button>
              )}
```

(`Code2`, `Eye`, `Button` já estão importados — usados pelo botão do Markdown.)

- [ ] **Step 5: Adicionar o ramo de renderização**

Na cadeia de `activeTab?.image ? … : … :` (área de conteúdo, ~linha 800-836), insira um novo ramo logo ANTES do ramo `mdPreview ? (`. Ou seja, troque:

```jsx
          ) : mdPreview ? (
```

por:

```jsx
          ) : htmlShown ? (
            <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-muted-foreground">{t('code.loading_preview')}</div>}>
              <HtmlViewer path={activeTab.path} />
            </Suspense>
          ) : mdPreview ? (
```

- [ ] **Step 6: Build**

Run: `npm run build`
Expected: build conclui sem erro.

- [ ] **Step 7: Teste manual (você reabre o app — não relançar à força)**

Abra/reinicie o app pelo seu fluxo normal (`npm start` numa janela livre, ou reabrir o app). Verifique:
1. Abrir um `.html` → aparece o código + botão **👁 Visualizar** na barra.
2. Clicar no olhinho → a área vira a página renderizada; botão vira **‹› Código**.
3. Um `.html` que puxa `./style.css`/imagem da pasta → o estilo/imagem aparece.
4. Editar o HTML (fica "sujo") e clicar em Visualizar → salva sozinho e o preview reflete a edição.
5. Abrir uma 2ª aba e voltar → cada `.html` lembra se estava em código ou preview.
6. Abrir um `.md` → continua com o comportamento de Markdown (preview por padrão), sem interferência.

- [ ] **Step 8: Commit**

```bash
git add src/components/CodeView.jsx
git commit -m "feat(html): botão de visualizar HTML inline no CodeView"
```

---

## Self-Review

**1. Spec coverage:**
- Botão de olhinho espelhando o Markdown → Task 4 (botão + ramo). ✓
- Renderização via `<webview src="file://">` (Chromium embutido, recursos relativos, sem Chrome) → Task 3. ✓
- Padrão de abertura = Código → Task 4 (estado `htmlPreview` é "set de quem está em preview"; padrão fora do set = código). ✓
- Salvar antes de visualizar → Task 4 Step 3 (`toggleHtmlPreview` salva se `dirty`). ✓
- Estado por aba → Task 4 (`Set` de paths). ✓
- Extensões `.html/.htm/.xhtml` → Task 1 (`isHtml`). ✓
- i18n pt+en com paridade → Task 2 (+ `npm run test:i18n`). ✓
- Botão oculto em notice/binário → Task 4 Step 4 (condição `!activeTab.notice && !image && !pdf && !xlsx`). ✓
- Falha ao salvar não entra em preview → Task 4 Step 3 (`if (res.error) return;`). ✓
- Escopo read-only, sem partition/grab/devtools → Task 3 (componente mínimo). ✓
- Fora de escopo (abrir no Chrome externo, live reload, srcdoc) → não implementado. ✓

**2. Placeholder scan:** Sem TBD/TODO; todo código está completo nos steps.

**3. Type consistency:** `isHtml(name)` e `fileUrlFor(path)` definidos na Task 1, consumidos com a mesma assinatura nas Tasks 3 e 4. `HtmlViewer({ path })` definido na Task 3, usado com `path={activeTab.path}` na Task 4. Chaves `code.html_*` definidas na Task 2, usadas na Task 4. Consistente.
