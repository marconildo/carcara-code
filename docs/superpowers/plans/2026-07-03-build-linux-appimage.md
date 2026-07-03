# Build de Linux (AppImage) — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Distribuir o Carcará Code para Linux como um AppImage oficial, publicado automaticamente junto do `.exe` do Windows a cada release.

**Architecture:** Trabalho de empacotamento e CI, sem mudança de comportamento do app. Adiciona um alvo `linux` (AppImage) ao electron-builder, um script npm, e um workflow do GitHub Actions gêmeo do de Windows rodando em `ubuntu-latest`. Distribuição via GitHub Releases (mesma tag `v*` gera Windows e Linux). README e site de marketing passam a oferecer o download de Linux.

**Tech Stack:** Electron 33, electron-builder 26, electron-updater, node-pty (único módulo nativo, com prebuilds para Linux), GitHub Actions (`ubuntu-latest`), Astro (site, repo separado).

## Global Constraints

- **Só AppImage.** Nada de `.deb`, `.rpm`, Snap ou Flatpak (sandbox quebraria os spawns do sistema: `claude`, `node`, `git`, shells, dev servers).
- **Sem macOS** neste plano.
- **AppImage só compila em Linux** — a validação end-to-end acontece no CI (`ubuntu-latest`), não na máquina Windows do dev. Comandos `pack:appimage` locais em Windows falham por design.
- **Node 20** no CI, cache npm, `npm ci` (espelha o workflow de Windows existente).
- **Não fazer `git push` sem OK explícito do usuário** (regra do projeto: backup diário é só commit local). As Tasks 2 e 4 precisam de push/deploy — pare e confirme antes.
- **App e site em sincronia**: mudança de download aqui exige refletir no site `carcara-code-site` (Astro → carcaracode.net).
- O bloco `build` atual mantém `npmRebuild: false` e `asarUnpack` do `node-pty` — continuam válidos, não remover.
- Config de Linux espelha o bloco `win` já existente (mesmo estilo, comentários em português no workflow).

---

### Task 1: Alvo `linux` (AppImage) no electron-builder

**Files:**
- Modify: `package.json` (objeto `build`, entre os blocos `win`/`nsis`; e objeto `scripts`)

**Interfaces:**
- Consumes: `build.win` como modelo; `build/icon.png` (256px, já existe); `build.publish` já aponta para o GitHub owner/repo.
- Produces: script npm `pack:appimage`; alvo `AppImage` que gera `release/CarcaraCode-${version}.AppImage` e `release/latest-linux.yml` quando rodado em Linux.

- [ ] **Step 1: Adicionar o bloco `linux` ao objeto `build`**

No `package.json`, logo após o bloco `"nsis": { ... }` (e sua vírgula), dentro de `"build"`, adicionar:

```jsonc
"linux": {
  "target": "AppImage",
  "icon": "build/icon.png",
  "category": "Development",
  "artifactName": "CarcaraCode-${version}.AppImage"
}
```

Garantir que o item anterior (`nsis`) termine com vírgula e que o JSON continue válido (o `linux` é o último item de `build`, sem vírgula depois dele).

- [ ] **Step 2: Adicionar o script `pack:appimage`**

No objeto `"scripts"`, depois de `"pack:exe": "..."`, adicionar:

```jsonc
"pack:appimage": "vite build && electron-builder --linux AppImage --publish never",
```

- [ ] **Step 3: Validar que o `package.json` continua sendo JSON válido**

Run: `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('json ok')"`
Expected: imprime `json ok` (sem erro de parse).

- [ ] **Step 4: Validar que o electron-builder aceita a config do Linux**

Run: `npx electron-builder --linux AppImage --dir --publish never 2>&1 | head -n 40`
Expected: o electron-builder inicia e reconhece o alvo `linux/AppImage`. Em Windows, o build pode falhar mais adiante por ser um alvo Linux (mensagem sobre precisar de Linux/Docker) — isso é esperado e aceitável; o que importa é NÃO haver erro de configuração inválida (ex.: "Unknown target", "invalid icon"). Se aparecer erro de config, corrigir antes de commitar. A compilação de verdade acontece no CI (Task 2).

- [ ] **Step 5: Commit**

```bash
git add package.json
git commit -m "feat: alvo de build Linux (AppImage) no electron-builder"
```

---

### Task 2: Workflow de CI para Linux

**Files:**
- Create: `.github/workflows/build-linux.yml`
- Reference: `.github/workflows/build-windows.yml` (modelo)

**Interfaces:**
- Consumes: script `pack:appimage` (Task 1); `build.publish` do `package.json`.
- Produces: artefato `CarcaraCode-Linux` (o `.AppImage`) em execuções manuais; e, em tags `v*`, `release/*.AppImage` + `release/latest-linux.yml` anexados à GitHub Release da tag.

- [ ] **Step 1: Criar o arquivo do workflow**

Create `.github/workflows/build-linux.yml` com o conteúdo:

```yaml
name: Build Linux

# Quando este build roda:
#  - Manualmente, pelo botão "Run workflow" na aba Actions do GitHub
#  - Automaticamente, quando você cria uma tag começando com "v" (ex: v0.1.0)
on:
  workflow_dispatch:
  push:
    tags:
      - "v*"

# Dá ao token do Actions permissão de escrita no repo, necessária para
# o passo que cria a página de Release (sem isso, dá erro 403).
permissions:
  contents: write

jobs:
  build:
    runs-on: ubuntu-latest

    steps:
      - name: Baixar o código
        uses: actions/checkout@v4

      - name: Instalar Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "npm"

      - name: Instalar dependências
        run: npm ci

      - name: Gerar o AppImage
        run: npm run pack:appimage

      # Deixa o .AppImage disponível pra baixar na própria página da execução,
      # mesmo quando o build foi disparado manualmente (sem tag).
      - name: Publicar o AppImage como artefato
        uses: actions/upload-artifact@v4
        with:
          name: CarcaraCode-Linux
          path: release/*.AppImage
          retention-days: 30
          if-no-files-found: error

      # Só quando for uma tag (ex: v0.1.0): anexa o AppImage à MESMA página de
      # Release onde o .exe do Windows também é publicado (action-gh-release faz
      # upsert na release da tag — os artefatos dos dois workflows se somam).
      - name: Publicar Release (somente em tags)
        if: startsWith(github.ref, 'refs/tags/v')
        uses: softprops/action-gh-release@v2
        with:
          files: |
            release/*.AppImage
            release/latest-linux.yml
          generate_release_notes: true
```

- [ ] **Step 2: Validar a sintaxe YAML do workflow**

Run: `node -e "const f=require('fs').readFileSync('.github/workflows/build-linux.yml','utf8'); if(!/runs-on: ubuntu-latest/.test(f)||!/pack:appimage/.test(f)) throw new Error('workflow incompleto'); console.log('workflow ok')"`
Expected: imprime `workflow ok`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/build-linux.yml
git commit -m "ci: workflow de build Linux (AppImage)"
```

- [ ] **Step 4: PARE e confirme o push com o usuário**

O workflow só roda no GitHub depois de `git push`. A regra do projeto é não dar push sem OK explícito. Pergunte ao usuário se pode fazer `git push`. Só depois do "sim":

```bash
git push origin main
```

- [ ] **Step 5: Disparar o workflow manualmente e validar o AppImage (validação end-to-end real)**

Depois do push, com o `gh` CLI autenticado:

Run: `gh workflow run "Build Linux" && sleep 5 && gh run list --workflow "Build Linux" --limit 1`
Depois acompanhe: `gh run watch $(gh run list --workflow "Build Linux" --limit 1 --json databaseId --jq '.[0].databaseId')`
Expected: o run termina com `completed / success` e o passo "Publicar o AppImage como artefato" sobe um `CarcaraCode-*.AppImage`. Se o `npm ci` ou o `node-pty` falharem no Linux, o log deste run é onde aparece — corrigir aqui antes de seguir. (Este é o teste que a máquina Windows não consegue fazer localmente.)

---

### Task 3: Atualizar o README com o download de Linux

**Files:**
- Modify: `README.md` (seção "Baixar", por volta das linhas 66-70)

**Interfaces:**
- Consumes: nome do artefato `CarcaraCode-${version}.AppImage` (Task 1).
- Produces: instruções de download/execução do AppImage para o usuário final.

- [ ] **Step 1: Renomear a seção e adicionar as instruções de Linux**

Substituir o trecho atual:

```markdown
## Baixar (Windows)

Pegue o instalador mais recente na página de **[Releases](../../releases)**. Baixe o `CarcaraCode-Setup-*.exe`, execute e pronto.

> Na primeira execução o Windows pode mostrar um aviso do SmartScreen ("O Windows protegeu seu PC"), porque o instalador ainda não é assinado. Clique em **Mais informações → Executar assim mesmo**. É seguro — o código é aberto, dá pra auditar tudo aqui.
```

por:

```markdown
## Baixar

Pegue a versão mais recente na página de **[Releases](../../releases)**.

**Windows** — baixe o `CarcaraCode-Setup-*.exe`, execute e pronto.

> Na primeira execução o Windows pode mostrar um aviso do SmartScreen ("O Windows protegeu seu PC"), porque o instalador ainda não é assinado. Clique em **Mais informações → Executar assim mesmo**. É seguro — o código é aberto, dá pra auditar tudo aqui.

**Linux** — baixe o `CarcaraCode-*.AppImage`, dê permissão de execução e abra:

```bash
chmod +x CarcaraCode-*.AppImage
./CarcaraCode-*.AppImage
```

> É um arquivo único e portátil — não precisa instalar. No gerenciador de arquivos, dá também pra marcar "Permitir execução" nas propriedades e abrir com duplo-clique.
```

- [ ] **Step 2: Validar que o README menciona os dois sistemas**

Run: `node -e "const f=require('fs').readFileSync('README.md','utf8'); if(!/AppImage/.test(f)||!/CarcaraCode-Setup/.test(f)) throw new Error('README faltando um dos downloads'); console.log('readme ok')"`
Expected: imprime `readme ok`.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: instruções de download do AppImage (Linux) no README"
```

---

### Task 4: Atualizar o site de marketing (repo separado)

**Files:**
- Modify: no repo `carcara-code-site` (caminho: `../carcara-code-site`, ou `...\github\carcara-code-site`) — a página/seção de download onde hoje o `.exe` é oferecido.
- Reference: `CLAUDE.md` deste repo (regra de manter site em sincronia).

**Interfaces:**
- Consumes: nome do artefato `CarcaraCode-*.AppImage`; link de Releases do GitHub.
- Produces: opção de download de Linux no carcaracode.net.

- [ ] **Step 1: Localizar onde o site oferece o download de Windows**

Run (a partir do repo do site): `grep -rn "CarcaraCode-Setup\|releases\|\.exe\|[Bb]aixar\|[Dd]ownload" src/ 2>/dev/null | head -n 30`
Expected: aparece o componente/página com o botão ou link de download do `.exe`. Anotar o arquivo exato para editar.

- [ ] **Step 2: Adicionar a opção de download de Linux**

No mesmo componente do botão de Windows, adicionar um botão/link "Linux (AppImage)" apontando para a página de Releases do GitHub (`https://github.com/Yg0rAndrade/carcara-code/releases/latest`), no mesmo estilo visual do botão de Windows já existente (reaproveitar a classe/componente, não criar estilo novo). Se o site tiver detecção de SO, incluir Linux na lógica; se for lista de botões, adicionar mais um.

- [ ] **Step 3: Buildar o site para garantir que não quebrou**

Run (no repo do site): `npm run build`
Expected: build conclui sem erro; o botão de Linux aparece no output.

- [ ] **Step 4: Commit no repo do site**

```bash
git add -A
git commit -m "feat: opção de download de Linux (AppImage)"
```

- [ ] **Step 5: PARE e confirme deploy/push com o usuário**

Deploy do site é via Cloudflare e envolve push. Confirmar com o usuário antes de fazer `git push` / deploy do site.

---

## Notas de execução

- **Ordem:** Task 1 → 2 são o núcleo (config + CI, mesmo repo). Task 3 (README) pode ir junto. Task 4 (site) é em outro repositório e pode ser feita por último.
- **A validação que importa** é a Task 2, Step 5: rodar o workflow no CI e ver o `.AppImage` sair. Só depois de um run verde faz sentido cravar numa tag `v*` de release.
- **Primeira release real de Linux:** depois que o workflow manual passar, criar/empurrar uma tag `v*` (ex.: `v0.1.6`) dispara Windows e Linux na mesma Release — mas isso é uma ação de release à parte, com OK do usuário (envolve push de tag).
