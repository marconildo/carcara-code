# Onboarding Scaffold Wizard — Backlog (pós-v1)

Estado em 2026-07-10. A v1 (spec/plano em `docs/specs|plans/2026-07-10-onboarding-scaffold-wizard*`)
está implementada, revisada e **validada rodando o app**. Este arquivo é o backlog do que
o Ygor pediu depois, testando ao vivo.

## ✅ Feito e commitado nesta sessão (depois do plano)

- **Bug do Next corrigido** (`9a036e9`): create-next-app rejeitava o tempdir `.carcara-scaffold`
  ("npm: nome não pode começar com ponto"). Tempdir → `carcara-scaffold-tmp` (nome npm-válido).
  Vite/Astro não validavam, por isso só o Next quebrava. Validado ponta-a-ponta (exit 0).
- **Nome real no package.json** (`9a036e9`): os create-* derivam o `name` do basename do tempdir;
  agora o motor reescreve pós-merge com o nome da pasta do projeto (`sanitizePackageName`).
- **Card HTML/CSS/JS removido** (`9a036e9`): nativo não é boa prática (decisão do Ygor).
- **Descrições por caso de uso** (`9a036e9`): React="Aplicativos web", Next="Aplicativos web com
  SEO", Astro="Sites de conteúdo (landing, blog)".
- Fixes anteriores (na branch): TDZ do PreviewPanel (`5ffc727`), cleanup best-effort + tolerar
  tempdir (`23901d5`), frame stale ao trocar projeto (`839eb5b`).

## 🔜 Pedido, falta fazer — POLISH DE UI (cards) — batch pequeno

1. **Logos reais** de cada framework no card (React/Next/Astro) no lugar dos ícones lucide.
   - Assets: usar SVG de marca (ex.: paths do simple-icons, CC0) inline no ScaffoldWizard.
     React (react), Next.js (nextdotjs), Astro (astro). Manter tamanho/《alinhamento dos cards.
2. **Tooltip "i" de informação** por card: ao passar o mouse, explica em linguagem simples e
   direta (SEM jargão) o que é cada um. Copy-base do Ygor (a REFINAR/estruturar):
   - React: "Pra criar um aplicativo web de uma página só (rápido e interativo)."
   - Next.js: "É o React, mas com várias páginas e feito pra aparecer no Google (SEO)."
   - Astro: "O melhor pra sites de conteúdo (landing pages, blogs) que precisam aparecer no Google."
   - Verificar se o app já tem componente Tooltip (shadcn/ui em src/components/ui/) pra reusar.
3. **Placeholder mínimo** no lugar da tela de demo (Vite/Next/Astro). Design aprovado:
   "placeholder mínimo VISÍVEL" (título simples tipo o nome do projeto/"Comece aqui" + CSS zerado),
   NÃO em branco total. Passo pós-scaffold por-stack: sobrescrever os arquivos de entrada
   (React: src/App.jsx + limpar App.css/index.css; Next: src/app/page.tsx + globals; Astro:
   src/pages/index.astro). Dados puros no scaffold-core (arquivos por stack), engine escreve.

## 🧩 Pedido, PRECISA DE DESIGN (maior) — não começar sem brainstorm

4. **Stack nova: Extensão de Chrome.** Criar a estrutura que o Chrome pede (manifest.json v3,
   pasta do popup, popup.html/js, ícones, background/service worker). Problema de design: o
   Preview do app é um webview de dev server — uma extensão roda DENTRO do Chrome, não previewa
   igual. Decidir: previewar só o popup como página? Instruir "carregar sem compactar" no
   chrome://extensions? Provavelmente stack "files" (template próprio) — reintroduz a manutenção
   de template que a v1 evitou. → Brainstorm próprio.
5. **Quiz "não sei escolher".** Botão/opção que faz perguntas e recomenda o stack. Lógica do Ygor:
   - "É interno ou externo (público)?" → interno pode ser React; externo pensa em SEO.
   - "Precisa aparecer no Google?" → sim: Astro ou Next.
   - "Que tipo?" → dashboards/integração de API = Next; blog/landing/site instrucional =
     Astro (conteúdo) ou React (app de página só).
     Mapear respostas → stackId do catálogo. Passo ANTES do `pick`. → Brainstorm próprio (árvore
     de decisão + copy).

## Notas técnicas p/ quem continuar

- Toda mudança no main.js/scaffold-core (processo main) exige RELANÇAR o app pra testar (não
  basta build). Mudança só de renderer (ScaffoldWizard/PreviewPanel/i18n) precisa de `npm run
build` + reload. Não relançar sem confirmar (pode ter sessão viva do Claude).
- Smoke pós-mudança: `node scripts/platform-smoke.cjs` (scaffold-core puro) + `npm run build` +
  (se i18n) `npm run test:i18n`.
- Catálogo puro em `electron/scaffold-core.cjs`; motor (spawn/merge/fixPackageName) em `main.js`
  seção "Onboarding: scaffold"; UI em `src/components/ScaffoldWizard.jsx` montada no
  `PreviewPanel.jsx` (ramo mode==='empty').
- Branch `feat/recursos-0.1.8` carrega TAMBÉM a feature "CLIs de IA" (paralela, completa). Sem
  push/merge sem OK. CHANGELOG.md a atualizar no release.
