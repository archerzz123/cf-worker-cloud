/**
 * Cloudflare Workers — 统一翻译 / 词典 / TTS 网关
 *
 * 端点
 *   GET  /v1/models              — 返回所有支持的模型列表
 *   POST /v1/chat/completions    — 文字翻译 / 词典查询
 *   POST /v1/audio/speech        — TTS 语音合成
 *
 * ── Chat 请求体 ──────────────────────────────────────────────
 * {
 *   "model":       "google-translate",
 *   "messages":    [{ "role": "user", "content": "hello" }],
 *   "source_lang": "auto",
 *   "target_lang": "zh",
 *   "nums":        5              // iciba-suggest / youdao-suggest 专用
 * }
 *
 * ── TTS 请求体 ───────────────────────────────────────────────
 * {
 *   "model": "google-tts",
 *   "input": "hello",
 *   "voice": "en",               // google-tts: 语言代码
 *   "speed": 1.0,                // google-tts: 语速
 *   "type":  1                   // youdao / iciba: 1=英式, 2=美式
 * }
 */

// ─── CORS ────────────────────────────────────────────────────────────────────

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// ─── 模型目录 ─────────────────────────────────────────────────────────────────

const MODELS = [
  { id: "google-tts",          object: "model", owned_by: "google",    type: "tts",  description: "Google TTS — 文字转语音",                     params: ["input", "voice(语言代码)", "speed"] },
  { id: "google-translate",    object: "model", owned_by: "google",    type: "chat", description: "Google Translate — 机器翻译",                 params: ["messages", "source_lang", "target_lang"] },
  { id: "google-dict",         object: "model", owned_by: "google",    type: "chat", description: "Google Dict — 词典（含更多 dt 字段）",         params: ["messages", "source_lang", "target_lang"] },
  { id: "youdao-dictvoice",    object: "model", owned_by: "youdao",    type: "tts",  description: "有道词典发音 — type: 1=英式(默认) 2=美式",     params: ["input", "type"] },
  { id: "youdao-dict",         object: "model", owned_by: "youdao",    type: "chat", description: "有道词典查询",                                 params: ["messages"] },
  { id: "youdao-suggest",      object: "model", owned_by: "youdao",    type: "chat", description: "有道单词联想",                                 params: ["messages", "nums(默认5)"] },
  { id: "iciba-dictvoice",     object: "model", owned_by: "iciba",     type: "tts",  description: "金山词霸发音 — type: 1=英式(默认) 2=美式",     params: ["input", "type"] },
  { id: "iciba-dict",          object: "model", owned_by: "iciba",     type: "chat", description: "金山词霸词典查询",                             params: ["messages"] },
  { id: "iciba-suggest",       object: "model", owned_by: "iciba",     type: "chat", description: "金山词霸单词联想",                             params: ["messages", "nums(默认5)"] },
  { id: "microsoft-translate", object: "model", owned_by: "microsoft", type: "chat", description: "Microsoft Translator — 机器翻译（原生多段）", params: ["messages", "source_lang(auto则省略)", "target_lang"] },
];

// ═══════════════════════════════════════════════════════════════════════════════
// ── 浏览器伪装 ────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

/** 随机从数组中取一项 */
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/** 生成随机公网 IPv4，自动跳过私有 / 保留段 */
function randomPublicIP() {
  let a, b, c, d;
  const isPrivate = (a, b) =>
    a === 10 ||
    a === 127 ||
    a === 0 ||
    a >= 224 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168);
  do {
    a = Math.floor(Math.random() * 223) + 1;
    b = Math.floor(Math.random() * 256);
    c = Math.floor(Math.random() * 256);
    d = Math.floor(Math.random() * 254) + 1;
  } while (isPrivate(a, b));
  return `${a}.${b}.${c}.${d}`;
}

/** User-Agent 候选池（Chrome / Edge / Firefox × Windows / Mac） */
const UA_POOL = [
  // Chrome · Windows
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  // Chrome · macOS
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  // Edge · Windows
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0",
  // Firefox · Windows
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0",
  // Firefox · macOS
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.4; rv:125.0) Gecko/20100101 Firefox/125.0",
  // Safari · macOS
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15",
];

/** 按站点分组的 Referer 候选池 */
const REFERER_POOL = {
  google: [
    "https://translate.google.com/",
    "https://www.google.com/",
    "https://google.com/",
  ],
  youdao: [
    "https://www.youdao.com/",
    "https://dict.youdao.com/",
    "https://fanyi.youdao.com/",
  ],
  iciba: [
    "https://www.iciba.com/",
    "https://dict.iciba.com/",
    "https://www.iciba.com/word",
  ],
  microsoft: [
    "https://www.bing.com/",
    "https://www.microsoft.com/",
    "https://translator.microsoft.com/",
  ],
};

/** Accept-Language 候选池 */
const LANG_POOL = [
  "en-US,en;q=0.9",
  "en-GB,en;q=0.9",
  "zh-CN,zh;q=0.9,en;q=0.8",
  "zh-TW,zh;q=0.9,en;q=0.8",
  "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
];

/**
 * 生成伪装浏览器请求头，每次调用均随机组合
 * @param {'google'|'youdao'|'iciba'|'microsoft'} site  — 用于匹配 Referer/Origin
 * @param {Record<string, string>} extra                — 额外覆盖/追加的头字段
 */
function fakeBrowserHeaders(site = "google", extra = {}) {
  const ua      = pick(UA_POOL);
  const referer = pick(REFERER_POOL[site] ?? REFERER_POOL.google);
  const origin  = referer.replace(/\/$/, "");

  // 随机 IP — 按概率生成 1~3 跳的 X-Forwarded-For 链
  const ip1 = randomPublicIP();
  const ip2 = randomPublicIP();
  const ip3 = randomPublicIP();
  const r = Math.random();
  const forwardedFor =
    r < 0.4 ? ip1
    : r < 0.7 ? `${ip1}, ${ip2}`
    : `${ip1}, ${ip2}, ${ip3}`;

  return {
    "User-Agent":       ua,
    Accept:             "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language":  pick(LANG_POOL),
    "Accept-Encoding":  "gzip, deflate, br",
    // Referer:            referer,
    // Origin:             origin,
    "Sec-Fetch-Dest":   "empty",
    "Sec-Fetch-Mode":   "cors",
    "Sec-Fetch-Site":   "same-origin",
    Connection:         "keep-alive",
    // IP 来源伪装
    "X-Forwarded-For":  forwardedFor,
    "X-Real-IP":        ip1,
    "CF-Connecting-IP": ip1,
    "X-Client-IP":      ip2,
    "True-Client-IP":   ip1,
    // 调用方覆盖字段放最后
    ...extra,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── 响应工具 ──────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}

function errResp(message, status = 400) {
  return jsonResp({ error: message, status }, status);
}

/** 透传上游全部 headers，叠加 CORS */
function audioResp(upstreamRes) {
  const headers = new Headers(upstreamRes.headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "audio/mpeg");
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  return new Response(upstreamRes.body, { status: upstreamRes.status, headers });
}

/** 下载远程 mp3（media-utils.js downloadFile） */
async function downloadFile(url) {
  const res = await fetch(url, { headers: fakeBrowserHeaders("iciba") });
  if (!res.ok) throw new Error(`下载失败 ${url} → HTTP ${res.status}`);
  return res;
}

/** 拼接 messages 所有 content，换行分隔 */
function joinContent(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const joined = messages.map((m) => m?.content ?? "").join("\n").trim();
  return joined || null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── 路由入口 ──────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

export default {
  async fetch(request, env, ctx) {
    try {
      const { pathname } = new URL(request.url);
      const method = request.method.toUpperCase();

      if (method === "OPTIONS")
        return new Response(null, { status: 204, headers: CORS });

      if (pathname === "/v1/models" && method === "GET")
        return jsonResp({ object: "list", data: MODELS });

      const apikey = request.headers.get("Authorization")?.replace("Bearer ", "") || request.headers.get("X-API-Key");
      if (apikey !== env.API_KEY) {
        return errResp('Unauthorization', 401);
      }

      if (pathname === "/v1/chat/completions" && method === "POST")
        return await handleChat(request);

      if (pathname === "/v1/audio/speech" && method === "POST")
        return await handleTTS(request);

      return errResp("路径不存在，请查看 GET /v1/models 获取使用说明", 404);
    } catch (error) {
      return errResp(`内部错误: ${error.message}`, 500);
    }
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// ── Chat 路由 ─────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

async function handleChat(request) {
  let body;
  try { body = await request.json(); }
  catch { return errResp("请求体必须是合法的 JSON"); }

  const { model, messages, source_lang = "auto", target_lang = "zh", nums = 5 } = body;

  if (!model) return errResp("缺少 model 字段");

  const text = joinContent(messages);
  if (!text) return errResp("messages 中缺少用户消息");

  try {
    switch (model) {
      case "google-translate":    return await googleTranslate(text, source_lang, target_lang);
      case "google-dict":         return await googleDict(text, source_lang, target_lang);
      case "youdao-dict":         return await youdaoDict(text);
      case "youdao-suggest":      return await youdaoSuggest(text, Number(nums));
      case "iciba-dict":          return await icibaDict(text);
      case "iciba-suggest":       return await icibaSuggest(text, Number(nums));
      case "microsoft-translate":
        // 原生支持数组，直接转换，不做 join
        return await microsoftTranslate(messages, source_lang, target_lang);
      default:
        return errResp(`不支持的 chat 模型: ${model}，请查看 GET /v1/models`);
    }
  } catch (e) {
    return errResp(`上游请求失败: ${e.message}`, 502);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── TTS 路由 ──────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

async function handleTTS(request) {
  let body;
  try { body = await request.json(); }
  catch { return errResp("请求体必须是合法的 JSON"); }

  const { model, input, voice = "en", speed = 1.0, type = 1 } = body;

  if (!model) return errResp("缺少 model 字段");
  if (!input) return errResp("缺少 input 字段");

  try {
    switch (model) {
      case "google-tts":       return await googleTTS(input, voice, Number(speed));
      case "youdao-dictvoice": return await youdaoTTS(input, Number(type));
      case "iciba-dictvoice":  return await icibaTTS(input, Number(type));
      default:
        return errResp(`不支持的 TTS 模型: ${model}，请查看 GET /v1/models`);
    }
  } catch (e) {
    return errResp(`上游请求失败: ${e.message}`, 502);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── Google ────────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

async function googleTTS(text, lang, speed) {
  const url =
    `https://translate.googleapis.com/translate_tts` +
    `?ie=UTF-8&tl=${encodeURIComponent(lang)}&client=tw-ob` +
    `&q=${encodeURIComponent(text)}&ttsspeed=${speed}`;

  const res = await fetch(url, { headers: fakeBrowserHeaders("google") });
  if (!res.ok) throw new Error(`Google TTS HTTP ${res.status}`);
  return audioResp(res);
}

async function googleTranslate(text, sourceLang, targetLang) {
  const url =
    `https://translate.googleapis.com/translate_a/single` +
    `?client=gtx&dj=1&dt=t&dt=at&dt=bd&dt=ex&dt=md&dt=rw&dt=ss&dt=rm` +
    `&q=${encodeURIComponent(text)}` +
    `&sl=${encodeURIComponent(sourceLang)}&source=icon&tk=100000.999999` +
    `&tl=${encodeURIComponent(targetLang)}`;

  const res = await fetch(url, { headers: fakeBrowserHeaders("google") });
  if (!res.ok) throw new Error(`Google Translate HTTP ${res.status}`);
  return jsonResp(await res.json());
}

async function googleDict(text, sourceLang, targetLang) {
  return googleTranslate(text, sourceLang, targetLang);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── 有道 ──────────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

async function youdaoTTS(word, type) {
  const safeType = type === 2 ? 2 : 1;
  const url = `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(word)}&type=${safeType}`;

  const res = await fetch(url, { headers: fakeBrowserHeaders("youdao") });
  if (!res.ok) throw new Error(`有道 TTS HTTP ${res.status}`);
  return audioResp(res);
}

async function youdaoDict(word) {
  const form = new URLSearchParams({
    q: word, le: "en", t: "1", client: "web",
    sign: "9583bb95a4a21a3870950688db121755", keyfrom: "webdict",
  });

  const res = await fetch(
    "https://dict.youdao.com/jsonapi_s?doctype=json&jsonversion=4",
    {
      method: "POST",
      headers: fakeBrowserHeaders("youdao", {
        "Content-Type": "application/x-www-form-urlencoded",
      }),
      body: form.toString(),
    }
  );
  if (!res.ok) throw new Error(`有道词典 HTTP ${res.status}`);
  return jsonResp(await res.json());
}

async function youdaoSuggest(word, num) {
  const url =
    `https://dict.youdao.com/suggest` +
    `?num=${num}&ver=3.0&doctype=json&q=${encodeURIComponent(word)}`;

  const res = await fetch(url, { headers: fakeBrowserHeaders("youdao") });
  if (!res.ok) throw new Error(`有道 Suggest HTTP ${res.status}`);
  return jsonResp(await res.json());
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── 金山词霸 ──────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

const ICIBA_BASE =
  "https://www.iciba.com/_next/data/SIgDISbkU9OFnSzS3LWHc/word.json";

async function icibaTTS(text, type) {
  const url = `${ICIBA_BASE}?w=${encodeURIComponent(text)}`;
  const res = await fetch(url, { headers: fakeBrowserHeaders("iciba") });
  if (!res.ok) throw new Error(`金山词霸词条 HTTP ${res.status}`);

  const json = await res.json();
  const symbols =
    json?.pageProps?.initialReduxState?.word?.wordInfo?.baesInfo?.symbols?.[0];
  if (!symbols) throw new Error("金山词霸响应中未找到 symbols 字段");

  const mp3Url =
    type === 2
      ? (symbols.ph_am_mp3_bk || symbols.ph_tts_mp3_bk)
      : (symbols.ph_en_mp3_bk || symbols.ph_tts_mp3_bk);

  if (!mp3Url) throw new Error("金山词霸响应中未找到可用的 mp3 链接");

  return audioResp(await downloadFile(mp3Url));
}

async function icibaDict(text) {
  const url = `${ICIBA_BASE}?w=${encodeURIComponent(text)}`;
  const res = await fetch(url, { headers: fakeBrowserHeaders("iciba") });
  if (!res.ok) throw new Error(`金山词霸词典 HTTP ${res.status}`);
  return jsonResp(await res.json());
}

async function icibaSuggest(text, nums) {
  const url =
    `https://dict.iciba.com/dictionary/word/suggestion` +
    `?word=${encodeURIComponent(text)}&nums=${nums}`;

  const res = await fetch(url, { headers: fakeBrowserHeaders("iciba") });
  if (!res.ok) throw new Error(`金山词霸 Suggest HTTP ${res.status}`);

  const json = await res.json();
  if (json.status !== 1) throw new Error("金山词霸 Suggest 返回失败状态");
  return jsonResp(json.message);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── Microsoft Translator ──────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

async function microsoftTranslate(messages, sourceLang, targetLang) {
  // Step 1: 获取免费 Bearer Token
  const authRes = await fetch("https://edge.microsoft.com/translate/auth", {
    headers: fakeBrowserHeaders("microsoft"),
  });
  if (!authRes.ok) throw new Error(`Microsoft Auth HTTP ${authRes.status}`);
  const token = await authRes.text();

  // Step 2: 翻译（原生支持多段数组）
  const params = new URLSearchParams({
    "api-version": "3.0",
    to: targetLang,
    includeSentenceLength: "true",
  });
  if (sourceLang && sourceLang !== "auto") params.set("from", sourceLang);

  const translateRes = await fetch(
    `https://api.cognitive.microsofttranslator.com/translate?${params}`,
    {
      method: "POST",
      headers: fakeBrowserHeaders("microsoft", {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      }),
      body: JSON.stringify(messages.map((m) => ({ Text: m?.content ?? "" }))),
    }
  );
  if (!translateRes.ok)
    throw new Error(`Microsoft Translate HTTP ${translateRes.status}`);

  return jsonResp(await translateRes.json());
}
