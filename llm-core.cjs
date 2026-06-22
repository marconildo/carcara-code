// Motor de IA local — sem dependência de Electron, testável por smoke via Node.
// node-llama-cpp v3 é ESM-only, então carregamos via import() dinâmico (lazy de fato:
// o binário nativo só entra na 1ª chamada que precisa dele).
const fs = require('fs');
const path = require('path');

const MODEL_ID = 'qwen2.5-0.5b-instruct-q4_k_m';
// node-llama-cpp v3 prefixes HuggingFace downloads with "hf_{org}_" — must match.
const MODEL_FILE = 'hf_bartowski_Qwen2.5-0.5B-Instruct-Q4_K_M.gguf';
const MODEL_URI = 'hf:bartowski/Qwen2.5-0.5B-Instruct-GGUF/Qwen2.5-0.5B-Instruct-Q4_K_M.gguf';

const GEN = { contextSize: 2048, temperature: 0.2, maxTokens: 48, timeoutMs: 20000 };

// Prompt de sistema fixo por tarefa. Travado: saída curta, sem explicação.
const SYSTEM = {
  commit:
    'Você gera mensagens de commit curtas em português, no estilo Conventional Commits ' +
    '(formato "tipo: descrição", ex.: "fix: corrige validação do login"). ' +
    'Máximo ~8 palavras. Responda APENAS a mensagem, sem aspas e sem explicação.',
};

let _libPromise; // cache do import() ESM
function lib() { return (_libPromise = _libPromise || import('node-llama-cpp')); }

let _llama, _model, _modelPathLoaded; // modelo fica quente após a 1ª geração

function modelsDir(userDataDir) { return path.join(userDataDir, 'models'); }
function modelPath(userDataDir) { return path.join(modelsDir(userDataDir), MODEL_FILE); }

// Returns the full path of the first *.gguf found in modelsDir, or null if none / dir missing.
function installedModelPath(userDataDir) {
  const dir = modelsDir(userDataDir);
  try {
    const entries = fs.readdirSync(dir);
    const gguf = entries.find(name => name.endsWith('.gguf'));
    return gguf ? path.join(dir, gguf) : null;
  } catch {
    return null;
  }
}

async function status(userDataDir) {
  const resolved = installedModelPath(userDataDir);
  if (resolved) {
    try {
      const st = fs.statSync(resolved);
      return { installed: true, path: resolved, sizeBytes: st.size };
    } catch {
      // file disappeared between readdir and stat
    }
  }
  return { installed: false, path: modelPath(userDataDir), sizeBytes: 0 };
}

async function download(userDataDir, onProgress) {
  const { createModelDownloader } = await lib();
  fs.mkdirSync(modelsDir(userDataDir), { recursive: true });
  const downloader = await createModelDownloader({
    modelUri: MODEL_URI,
    dirPath: modelsDir(userDataDir),
    onProgress: ({ totalSize, downloadedSize }) => {
      if (typeof onProgress === 'function') onProgress({ done: downloadedSize ?? 0, total: totalSize ?? 0 });
    },
  });
  const outPath = await downloader.download();
  return { path: outPath };
}

async function remove(userDataDir) {
  // Descarrega o que estiver quente antes de apagar o arquivo.
  try { if (_model) await _model.dispose(); } catch {}
  _model = null; _modelPathLoaded = null;
  try { if (_llama) await _llama.dispose(); } catch {}
  _llama = null;
  // Delete all *.gguf in the models dir (glob-based, robust to filename changes).
  const dir = modelsDir(userDataDir);
  try {
    const entries = fs.readdirSync(dir);
    for (const name of entries) {
      if (name.endsWith('.gguf')) {
        try { fs.unlinkSync(path.join(dir, name)); } catch {}
      }
    }
  } catch {}
}

async function ensureModel(userDataDir) {
  const p = installedModelPath(userDataDir);
  if (!p) throw new Error('Modelo não baixado.');
  const { getLlama } = await lib();
  if (!_llama) _llama = await getLlama();
  if (!_model || _modelPathLoaded !== p) {
    if (_model) { try { await _model.dispose(); } catch {} }
    _model = await _llama.loadModel({ modelPath: p });
    _modelPathLoaded = p;
  }
  return _model;
}

async function generate({ userDataDir, task, input }) {
  const sys = SYSTEM[task];
  if (!sys) throw new Error('Tarefa de IA desconhecida: ' + task);
  const model = await ensureModel(userDataDir);
  const { LlamaChatSession } = await lib();
  // Contexto fresco por chamada (sem histórico entre gerações); descartado no fim.
  const context = await model.createContext({ contextSize: GEN.contextSize });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), GEN.timeoutMs);
  try {
    const session = new LlamaChatSession({ contextSequence: context.getSequence(), systemPrompt: sys });
    const out = await session.prompt(String(input || ''), {
      temperature: GEN.temperature,
      maxTokens: GEN.maxTokens,
      signal: ac.signal,
    });
    return String(out || '').trim().replace(/^["'`]|["'`]$/g, '').split('\n')[0].trim();
  } finally {
    clearTimeout(timer);
    try { await context.dispose(); } catch {}
  }
}

module.exports = { MODEL_ID, MODEL_FILE, MODEL_URI, modelPath, status, download, remove, generate };
