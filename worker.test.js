import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import worker from './worker.js';

const API_KEY = 'test-key';
const BASE = 'https://example.com';

function authHeaders() {
  return { Authorization: `Bearer ${API_KEY}` };
}

function createRequest(path, options = {}) {
  return new Request(`${BASE}${path}`, options);
}

function createEnv() {
  return { API_KEY };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function readFixtureJson(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

test('未鉴权访问 /api 路由返回 401', async () => {
  const request = createRequest('/api/gg/tts?text=hello');
  const response = await worker.fetch(request, createEnv(), {});
  assert.equal(response.status, 401);
  const data = await response.json();
  assert.equal(data.code, 'UNAUTHORIZED');
  assert.equal(typeof data.request_id, 'string');
});

test('GET /api/gg/tts 正常返回音频', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const urlString = String(url);
    assert.match(urlString, /translate\.googleapis\.com\/translate_tts/);
    assert.match(urlString, /tl=fr/);
    return new Response('mock-mp3', {
      status: 200,
      headers: { 'Content-Type': 'audio/mpeg' },
    });
  };

  try {
    const request = createRequest('/api/gg/tts?text=hello&target_lang=fr&speed=1', {
      headers: authHeaders(),
    });
    const response = await worker.fetch(request, createEnv(), {});
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Type'), 'audio/mpeg');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /v1/audio/speech 的 google-tts 在非法 voice 时回退为 en', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const urlString = String(url);
    assert.match(urlString, /translate\.googleapis\.com\/translate_tts/);
    assert.match(urlString, /tl=en/);
    return new Response('mock-mp3', {
      status: 200,
      headers: { 'Content-Type': 'audio/mpeg' },
    });
  };

  try {
    const request = createRequest('/v1/audio/speech', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'google-tts',
        input: 'hello',
        voice: 'alloy',
      }),
    });
    const response = await worker.fetch(request, createEnv(), {});
    assert.equal(response.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /v1/audio/speech 的 google-tts 在空白 voice 时回退为 en', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const urlString = String(url);
    assert.match(urlString, /translate\.googleapis\.com\/translate_tts/);
    assert.match(urlString, /tl=en/);
    return new Response('mock-mp3', {
      status: 200,
      headers: { 'Content-Type': 'audio/mpeg' },
    });
  };

  try {
    const request = createRequest('/v1/audio/speech', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'google-tts',
        input: 'hello',
        voice: '   ',
      }),
    });
    const response = await worker.fetch(request, createEnv(), {});
    assert.equal(response.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /v1/audio/speech 的 google-tts 在合法 voice 时保留原值', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const urlString = String(url);
    assert.match(urlString, /translate\.googleapis\.com\/translate_tts/);
    assert.match(urlString, /tl=fr-CA/);
    return new Response('mock-mp3', {
      status: 200,
      headers: { 'Content-Type': 'audio/mpeg' },
    });
  };

  try {
    const request = createRequest('/v1/audio/speech', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'google-tts',
        input: 'hello',
        voice: 'fr-CA',
      }),
    });
    const response = await worker.fetch(request, createEnv(), {});
    assert.equal(response.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /api/ms/translate 正常返回翻译结果', async () => {
  const originalFetch = globalThis.fetch;
  let authCalled = false;
  let translateCalled = false;

  globalThis.fetch = async (url, init = {}) => {
    const asString = String(url);
    if (asString.includes('edge.microsoft.com/translate/auth')) {
      authCalled = true;
      return new Response('mock-token', { status: 200 });
    }
    if (asString.includes('api.cognitive.microsofttranslator.com/translate')) {
      translateCalled = true;
      assert.equal(init.method, 'POST');
      const body = JSON.parse(init.body);
      assert.deepEqual(body, [{ Text: 'hello world' }]);
      return jsonResponse([{ translations: [{ text: '你好，世界', to: 'zh-Hans' }] }]);
    }
    throw new Error(`unexpected url: ${asString}`);
  };

  try {
    const request = createRequest('/api/ms/translate', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello world', source_lang: 'en', target_lang: 'zh-Hans' }),
    });
    const response = await worker.fetch(request, createEnv(), {});
    assert.equal(response.status, 200);
    assert.equal(authCalled, true);
    assert.equal(translateCalled, true);
    const data = await response.json();
    assert.equal(typeof data.text, 'string');
    assert.match(data.text, /你好，世界/);
    assert.equal(Array.isArray(data.raw), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GET /api/iciba/dict 正常返回 JSON', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /www\.iciba\.com\/_next\/data\/.+\/word\.json/);
    return jsonResponse({ ok: true });
  };

  try {
    const request = createRequest('/api/iciba/dict?text=test', {
      headers: authHeaders(),
    });
    const response = await worker.fetch(request, createEnv(), {});
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(typeof data.text, 'string');
    assert.equal(typeof data.raw, 'object');
    assert.deepEqual(data.raw, { ok: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GET /api/gg/dict 返回 text 与 raw', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    jsonResponse({
      sentences: [{ trans: '哭', orig: 'cry' }],
      dict: [{ pos: '动词', terms: ['哭', '哭泣'] }],
      examples: { example: [{ text: 'I cry.', translation: '我哭。' }] },
    });

  try {
    const request = createRequest('/api/gg/dict?text=cry&source_lang=en&target_lang=zh-CN', {
      headers: authHeaders(),
    });
    const response = await worker.fetch(request, createEnv(), {});
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(typeof data.text, 'string');
    assert.match(data.text, /翻译: 哭/);
    assert.match(data.text, /动词: 哭、哭泣/);
    assert.equal(typeof data.raw, 'object');
    assert.equal(data.raw.sentences[0].trans, '哭');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GET /api/youdao/dict 基于真实数据整理 text', async () => {
  const originalFetch = globalThis.fetch;
  const fixture = readFixtureJson('./simple/youdo-dict-do.json');
  globalThis.fetch = async () => jsonResponse(fixture);

  try {
    const request = createRequest('/api/youdao/dict?text=do', {
      headers: authHeaders(),
    });
    const response = await worker.fetch(request, createEnv(), {});
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.match(data.text, /单词: do/i);
    assert.match(data.text, /音标:/);
    assert.match(data.text, /v\./i);
    assert.equal(typeof data.raw, 'object');
    assert.equal(data.raw.input, 'do');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GET /api/youdao/suggest 基于真实数据整理 text', async () => {
  const originalFetch = globalThis.fetch;
  const fixture = readFixtureJson('./simple/youdao-suggest-do.json');
  globalThis.fetch = async () => jsonResponse(fixture);

  try {
    const request = createRequest('/api/youdao/suggest?text=do&nums=5', {
      headers: authHeaders(),
    });
    const response = await worker.fetch(request, createEnv(), {});
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.match(data.text, /^do:/m);
    assert.equal(typeof data.raw, 'object');
    assert.equal(Array.isArray(data.raw.data.entries), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GET /api/iciba/dict 基于真实数据整理 text', async () => {
  const originalFetch = globalThis.fetch;
  const fixture = readFixtureJson('./simple/iciba-dict-do.json');
  globalThis.fetch = async () => jsonResponse(fixture);

  try {
    const request = createRequest('/api/iciba/dict?text=do', {
      headers: authHeaders(),
    });
    const response = await worker.fetch(request, createEnv(), {});
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.match(data.text, /单词: do/i);
    assert.match(data.text, /音标:/);
    assert.match(data.text, /例句:/);
    assert.equal(typeof data.raw, 'object');
    assert.equal(data.raw.pageProps.initialReduxState.word.wordInfo.baesInfo.word_name, 'do');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('GET /api/iciba/suggest 基于真实数据整理 text', async () => {
  const originalFetch = globalThis.fetch;
  const fixture = readFixtureJson('./simple/iciba-suggestion-do.json');
  globalThis.fetch = async () => jsonResponse(fixture);

  try {
    const request = createRequest('/api/iciba/suggest?text=do&nums=5', {
      headers: authHeaders(),
    });
    const response = await worker.fetch(request, createEnv(), {});
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.match(data.text, /^do:/m);
    assert.equal(typeof data.raw, 'object');
    assert.equal(data.raw.status, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('不支持的 REST 路由返回 404', async () => {
  const request = createRequest('/api/unknown/dict?text=test', {
    headers: authHeaders(),
  });
  const response = await worker.fetch(request, createEnv(), {});
  assert.equal(response.status, 404);
});

test('REST 路由缺少 text 返回 400', async () => {
  const request = createRequest('/api/gg/translate', {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ target_lang: 'zh' }),
  });
  const response = await worker.fetch(request, createEnv(), {});
  assert.equal(response.status, 400);
  const data = await response.json();
  assert.equal(data.code, 'MISSING_TEXT');
  assert.equal(typeof data.request_id, 'string');
});

test('上游失败时返回包含详细响应体的错误信息', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ message: 'quota exceeded' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json' },
    });

  try {
    const request = createRequest('/api/gg/tts?text=hello', {
      headers: authHeaders(),
    });
    const response = await worker.fetch(request, createEnv(), {});
    assert.equal(response.status, 502);
    const data = await response.json();
    assert.match(data.error, /Google TTS HTTP 429/);
    assert.match(data.error, /quota exceeded/);
    assert.equal(data.code, 'UPSTREAM_ERROR');
    assert.equal(typeof data.request_id, 'string');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /v1/chat/completions 缺少 model 返回统一错误结构', async () => {
  const request = createRequest('/v1/chat/completions', {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'hello world' }],
    }),
  });
  const response = await worker.fetch(request, createEnv(), {});
  assert.equal(response.status, 400);
  const data = await response.json();
  assert.equal(data.code, 'MISSING_MODEL');
  assert.equal(typeof data.request_id, 'string');
});

test('POST /v1/chat/completions 非法 JSON 返回统一错误结构', async () => {
  const request = createRequest('/v1/chat/completions', {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: '{ bad json',
  });
  const response = await worker.fetch(request, createEnv(), {});
  assert.equal(response.status, 400);
  const data = await response.json();
  assert.equal(data.code, 'INVALID_JSON');
  assert.equal(typeof data.request_id, 'string');
});

test('POST /v1/chat/completions 返回标准 OpenAI 兼容结构', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    jsonResponse({
      sentences: [{ trans: '你好' }, { trans: '世界' }],
    });

  try {
    const request = createRequest('/v1/chat/completions', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'google-translate',
        messages: [{ role: 'user', content: 'hello world' }],
        source_lang: 'en',
        target_lang: 'zh-CN',
      }),
    });
    const response = await worker.fetch(request, createEnv(), {});
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.object, 'chat.completion');
    assert.equal(typeof data.id, 'string');
    assert.equal(data.model, 'google-translate');
    assert.equal(Array.isArray(data.choices), true);
    assert.equal(data.choices[0].message.role, 'assistant');
    const content = JSON.parse(data.choices[0].message.content);
    assert.equal(content.text, '你好世界');
    assert.equal(content.raw.sentences[0].trans, '你好');
    assert.equal(typeof data.usage.total_tokens, 'number');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /v1/chat/completions 对词典模型也返回标准结构', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    jsonResponse({
      sentences: [{ trans: '哭', orig: 'cry' }],
      dict: [{ pos: '动词', terms: ['哭', '哭泣'] }],
      examples: { example: [{ text: 'I cry.', translation: '我哭。' }] },
    });

  try {
    const request = createRequest('/v1/chat/completions', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'youdao-dict',
        messages: [{ role: 'user', content: 'test' }],
      }),
    });
    const response = await worker.fetch(request, createEnv(), {});
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.object, 'chat.completion');
    assert.equal(data.model, 'youdao-dict');
    assert.equal(data.choices[0].message.role, 'assistant');
    assert.equal(typeof data.choices[0].message.content, 'string');
    assert.ok(data.choices[0].message.content.length > 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /v1/chat/completions 的 google-dict 返回 text 与 raw 的字符串化结果', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    jsonResponse({
      sentences: [{ trans: '哭', orig: 'cry' }],
      dict: [{ pos: '动词', terms: ['哭', '哭泣'] }],
      examples: { example: [{ text: 'I cry.', translation: '我哭。' }] },
    });

  try {
    const request = createRequest('/v1/chat/completions', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'google-dict',
        messages: [{ role: 'user', content: 'cry' }],
        source_lang: 'en',
        target_lang: 'zh-CN',
      }),
    });
    const response = await worker.fetch(request, createEnv(), {});
    assert.equal(response.status, 200);
    const data = await response.json();
    const content = data.choices[0].message.content;
    const parsed = JSON.parse(content);
    assert.equal(typeof parsed.text, 'string');
    assert.match(parsed.text, /翻译: 哭/);
    assert.equal(typeof parsed.raw, 'object');
    assert.equal(parsed.raw.sentences[0].orig, 'cry');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /v1/chat/completions 支持 stream=true 且仅输出 text', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    jsonResponse({
      sentences: [{ trans: '你好' }, { trans: '世界' }],
    });

  try {
    const request = createRequest('/v1/chat/completions', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'google-translate',
        stream: true,
        messages: [{ role: 'user', content: 'hello world' }],
        source_lang: 'en',
        target_lang: 'zh-CN',
      }),
    });
    const response = await worker.fetch(request, createEnv(), {});
    assert.equal(response.status, 200);
    assert.match(response.headers.get('Content-Type') || '', /text\/event-stream/);
    const bodyText = await response.text();
    assert.match(bodyText, /"object":"chat\.completion\.chunk"/);
    assert.match(bodyText, /"content":"你好世界"/);
    assert.doesNotMatch(bodyText, /"raw":/);
    assert.match(bodyText, /\[DONE\]/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /v1/chat/completions 支持 stream=\"true\"', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    jsonResponse({
      result: 'ok',
      data: { entries: [{ entry: 'do', explain: 'v. 做' }] },
    });

  try {
    const request = createRequest('/v1/chat/completions', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'youdao-suggest',
        stream: 'true',
        messages: [{ role: 'user', content: 'do' }],
      }),
    });
    const response = await worker.fetch(request, createEnv(), {});
    assert.equal(response.status, 200);
    const bodyText = await response.text();
    assert.match(bodyText, /"content":"do: v\."/);
    assert.match(bodyText, /"content":"做"/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /v1/chat/completions stream 对多句文本按句分块', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    jsonResponse({
      sentences: [{ trans: '第一句。第二句！Third?' }],
    });

  try {
    const request = createRequest('/v1/chat/completions', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'google-translate',
        stream: true,
        messages: [{ role: 'user', content: 'split me' }],
      }),
    });
    const response = await worker.fetch(request, createEnv(), {});
    assert.equal(response.status, 200);
    const bodyText = await response.text();
    assert.match(bodyText, /"content":"第一句。"/);
    assert.match(bodyText, /"content":"第二句！"/);
    assert.match(bodyText, /"content":"Third\?"/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /v1/chat/completions stream include_usage=true 返回 usage chunk', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    jsonResponse({
      sentences: [{ trans: '你好。世界。' }],
    });

  try {
    const request = createRequest('/v1/chat/completions', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'google-translate',
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: 'user', content: 'hello world' }],
      }),
    });
    const response = await worker.fetch(request, createEnv(), {});
    assert.equal(response.status, 200);
    const bodyText = await response.text();
    assert.match(bodyText, /"usage":\{"prompt_tokens":\d+,"completion_tokens":\d+,"total_tokens":\d+\}/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('POST /v1/chat/completions stream 默认不返回 usage chunk', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    jsonResponse({
      sentences: [{ trans: '你好。' }],
    });

  try {
    const request = createRequest('/v1/chat/completions', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'google-translate',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });
    const response = await worker.fetch(request, createEnv(), {});
    assert.equal(response.status, 200);
    const bodyText = await response.text();
    assert.doesNotMatch(bodyText, /"usage":\{/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
