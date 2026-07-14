// Modelo de TESTE local (OpenAI-compatible) pra exercitar o chat da Carcará sem
// depender de IA/chave externa. Faz streaming de uma resposta amigável.
// Uso: node scripts/carcara-mock-model.cjs   (sobe em http://127.0.0.1:8899/v1)
// Aponte o app: CARCARA_DEV_BASE_URL=http://127.0.0.1:8899/v1  CARCARA_DEV_MODEL=carcara-mock
const http = require('http');

const PORT = 8899;
const MODEL = 'carcara-mock';

function reply(userText) {
  const t = (userText || '').trim();
  return (
    `Olá! 👋 Aqui é o **modelo de teste local** da Carcará (sem IA externa).\n\n` +
    `Você disse: "${t || '(vazio)'}".\n\n` +
    `Se você está lendo isto aparecendo aos poucos, o **streaming**, as **bolhas** e o ` +
    `render estão funcionando. O chat tá 100%. 🎉`
  );
}

function lastUserText(body) {
  try {
    const msgs = (body && body.messages) || [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role === 'user') {
        if (typeof m.content === 'string') return m.content;
        if (Array.isArray(m.content))
          return m.content.map((c) => (typeof c === 'string' ? c : c.text || '')).join(' ');
      }
    }
  } catch {
    /* noop */
  }
  return '';
}

function sseChunk(res, obj) {
  res.write('data: ' + JSON.stringify(obj) + '\n\n');
}

const server = http.createServer((req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': '*',
  };
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    return res.end();
  }
  // Lista de modelos (o OpenCode/UI pode consultar).
  if (req.method === 'GET' && req.url.replace(/\/+$/, '').endsWith('/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
    return res.end(
      JSON.stringify({
        object: 'list',
        data: [{ id: MODEL, object: 'model', owned_by: 'carcara' }],
      }),
    );
  }
  // Chat completions.
  if (req.method === 'POST' && req.url.includes('/chat/completions')) {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      let body = {};
      try {
        body = JSON.parse(raw);
      } catch {
        /* noop */
      }
      const text = reply(lastUserText(body));
      const id = 'chatcmpl-mock';
      const created = 1700000000;
      console.log('[mock] POST /chat/completions stream=%s', !!body.stream);

      if (body.stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          ...cors,
        });
        sseChunk(res, {
          id,
          object: 'chat.completion.chunk',
          created,
          model: MODEL,
          choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
        });
        const tokens = text.match(/\s+|\S+/g) || [text];
        let i = 0;
        const tick = () => {
          if (i < tokens.length) {
            sseChunk(res, {
              id,
              object: 'chat.completion.chunk',
              created,
              model: MODEL,
              choices: [{ index: 0, delta: { content: tokens[i] }, finish_reason: null }],
            });
            i++;
            setTimeout(tick, 25);
          } else {
            sseChunk(res, {
              id,
              object: 'chat.completion.chunk',
              created,
              model: MODEL,
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            });
            res.write('data: [DONE]\n\n');
            res.end();
          }
        };
        tick();
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
        res.end(
          JSON.stringify({
            id,
            object: 'chat.completion',
            created,
            model: MODEL,
            choices: [
              { index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
      }
    });
    return;
  }
  res.writeHead(404, cors);
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('[mock] modelo de teste em http://127.0.0.1:' + PORT + '/v1 (modelo: ' + MODEL + ')');
});
