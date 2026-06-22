# IA local embutida (opcional) — v1: motor + sugestão de commit

**Data:** 2026-06-22
**Status:** Aprovado (design) — pronto para plano de implementação
**Escopo desta versão:** motor completo de IA local + primeiro ponto de uso (botão de commit). Títulos automáticos de histórico e de prompt ficam para um spec seguinte, reaproveitando o mesmo motor.

## Contexto

No Carcará Code, várias micro-tarefas de texto hoje são genéricas ou manuais:

- Mensagem de commit é 100% digitada à mão ([GitPanel.jsx](../../../src/components/GitPanel.jsx)).
- Título de checkpoint é só `"Após resposta do Claude <timestamp>"` ([main.js](../../../main.js) ~linha 1017).
- Título de prompt é "primeiros 40 caracteres do corpo" ([ChatPanel.jsx](../../../src/components/ChatPanel.jsx)).

O app já roda Claude Code (assinatura), mas usar a sessão do Claude para essas micro-tarefas é caro, lento e atrapalha o trabalho em andamento. A proposta é uma **IA local minúscula, offline e instantânea**, dedicada a essas tarefas curtas.

A IA é **opcional e modular**: o usuário ativa nas Configurações, baixa o modelo (~400MB, uma única vez) e liga só os recursos que quiser. Com a IA desligada, o app funciona exatamente como hoje.

## Princípios

- **Modular** — cada recurso de IA é um interruptor independente.
- **Opt-in** — o modelo não vem no instalador; baixa sob demanda; quem não quiser, nunca ativa.
- **Nunca no boot** — o binding nativo e o modelo carregam *lazy*, só na 1ª chamada (igual `node-pty`).
- **Degradação silenciosa** — IA desligada, modelo ausente, erro ou timeout → cai no comportamento atual. Nada bloqueia.
- **Sugere, não decide** — no commit, a IA preenche a textarea para o usuário editar; nunca commita sozinha.

## Arquitetura

### Motor: `llm-core.cjs` (novo, main process)

Mesmo molde de [mcp-core.cjs](../../../mcp-core.cjs): módulo CJS, testável por smoke, sem UI. Usa **`node-llama-cpp`** (binding nativo com prebuilds de CPU, sem etapa de compilação no usuário).

- `require('node-llama-cpp')` **lazy**, com cache em variável de módulo (igual `ptyLib` em [main.js:808](../../../main.js#L808)).
- Modelo padrão: **Qwen2.5 0.5B Instruct, quant Q4_K_M** (~400MB).
- Local do modelo: `app.getPath('userData')/models/` → `~/.carcara-code/models/qwen2.5-0.5b-instruct-q4_k_m.gguf`.
- Instância do modelo carregada na 1ª `generate` e mantida quente (singleton no módulo).
- Geração travada: `temperature` ~0.2, `maxTokens` ~40, prompt de sistema fixo por tarefa, `n_ctx` ~2048.

API do módulo (consumida pelos handlers IPC):

| Função | Retorno / efeito |
| --- | --- |
| `status()` | `{ installed, modelReady, path, sizeBytes }` |
| `download(onProgress)` | baixa o `.gguf` para `models/`, reporta progresso, valida tamanho/checksum |
| `remove()` | apaga o `.gguf` |
| `generate({ task, input })` | roda o prompt fixo da `task` e devolve texto curto; lança em erro/timeout |

### IPC (padrão `mcp:*` / `git:*`)

- [main.js](../../../main.js): `ipcMain.handle('llm:status' | 'llm:download' | 'llm:remove' | 'llm:generate', ...)`. O download emite progresso via `safeSend('llm:downloadProgress', {...})` (mesmo padrão do `term:data`).
- [preload.js](../../../preload.js): expor `llmStatus()`, `llmDownload()`, `llmRemove()`, `llmGenerate(task, input)` e `onLlmDownloadProgress(cb)`.

### Config (em `~/.carcara-code/config.json`)

Via `loadConfig`/`saveConfig` em [main.js:34](../../../main.js#L34):

```jsonc
"llm": {
  "enabled": false,                 // master
  "model": "qwen2.5-0.5b-instruct-q4_k_m",
  "features": { "commit": false }   // toggles por recurso (cresce nos próximos specs)
}
```

Novos handlers `llm:getConfig` / `llm:setConfig` (ou reaproveitar getter/setter genérico de config, se já houver).

### Empacotamento

- `node-llama-cpp` em `dependencies`; adicionar `**/node_modules/node-llama-cpp/**` ao `asarUnpack` em [package.json](../../../package.json) (hoje só `node-pty` está lá).
- Verificar no `pack:exe` que os prebuilds nativos entram no portable.

## UI

### Aba "Recursos de IA" no [SettingsModal.jsx](../../../src/components/SettingsModal.jsx)

Nova aba ao lado de "IA por projeto" / "Aparência" / "Notificações".

- **Master "Ativar IA local"** (usa o `switch.jsx` já existente em `src/components/ui/`).
- **Bloco do modelo**: estado (não baixado / baixando NN% / pronto), botão **Baixar (~400MB)** com barra de progresso (consome `onLlmDownloadProgress`) e botão **Remover**.
- **Interruptores por recurso** (desabilitados enquanto o modelo não estiver pronto):
  - ☐ Botão de sugestão de mensagem de commit *(único ativo na v1)*
  - Títulos de histórico/prompt aparecem como "em breve" / desabilitados.

### Botão de commit no [GitPanel.jsx](../../../src/components/GitPanel.jsx)

- Botão **"✨ Gerar"** ao lado da textarea de commit (~linha 236-241), visível **só** se `llm.enabled && llm.features.commit && modelReady`.
- Ao clicar: junta os diffs dos arquivos staged (via `git:diff`, já existente), chama `llmGenerate('commit', diffs)`, mostra um spinner no botão e **preenche a textarea** com o resultado.
- Erro/timeout → toast discreto "não consegui gerar agora" e a textarea fica como estava.

## Prompt fixo (task `commit`)

**Sistema:** "Você gera mensagens de commit curtas em português, no estilo Conventional Commits (`tipo: descrição`), máx. ~8 palavras, sem explicação. Responda só a mensagem."

**Entrada:** diff staged, truncado a um limite seguro de tokens para caber no `n_ctx` (~2048).

## Arquivos a criar / modificar

- **Criar:** `llm-core.cjs` (motor).
- **Modificar:** [main.js](../../../main.js) (handlers IPC + config `llm`), [preload.js](../../../preload.js) (expor API), [SettingsModal.jsx](../../../src/components/SettingsModal.jsx) (aba nova), [GitPanel.jsx](../../../src/components/GitPanel.jsx) (botão), [package.json](../../../package.json) (dep + `asarUnpack`).
- **Reusar:** padrão IPC do `mcp:*`; `loadConfig`/`saveConfig`; `safeSend`; `switch.jsx`; lazy-require do `node-pty`.

## Verificação (end-to-end)

1. **Boot intacto** — `npm run build` + abrir o app; confirmar que nada de LLM carrega no boot (sem `node-llama-cpp` no caminho de inicialização; tempo de splash igual).
2. **Smoke do motor** — script chamando `llm-core.cjs` `status()` e `generate({ task: 'commit', input: <diff de exemplo> })` fora do Electron (com `ELECTRON_RUN_AS_NODE` limpo), conferindo saída curta.
3. **Download** — na aba "Recursos de IA", clicar Baixar; ver a barra ir a 100% e o estado virar "pronto"; conferir o `.gguf` em `~/.carcara-code/models/`.
4. **Commit assist** — fazer stage de mudanças reais, clicar "✨ Gerar", confirmar que a textarea é preenchida com mensagem coerente em <~2s numa CPU comum; editar e commitar normalmente.
5. **Degradação** — desligar o master → botão "✨ Gerar" some, commit manual segue normal; remover o modelo → recursos desabilitam sem erro.

## Fora de escopo (v1)

- Títulos automáticos de histórico/checkpoint e de prompt (próximo spec, mesmo motor).
- Escolha de múltiplos modelos / quantizações na UI.
- Aceleração por GPU (CPU-only é suficiente para 0.5B e garante "qualquer PC básico").
