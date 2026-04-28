/**
 * Cloudflare Workers — 统一翻译 / 词典 / TTS 网关
 *
 * 端点
 *   GET  /v1/models              — 返回所有支持的模型列表
 *   POST /v1/chat/completions    — 文字翻译 / 词典查询
 *   POST /v1/audio/speech        — TTS 语音合成
 *   GET|POST /api/{provider}/{action} — RESTful 访问（示例: /api/gg/tts）
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

const HTTP_METHOD = {
  GET: "GET",
  POST: "POST",
  OPTIONS: "OPTIONS",
};

const PATH = {
  MODELS: "/v1/models",
  CHAT: "/v1/chat/completions",
  SPEECH: "/v1/audio/speech",
};

const DEFAULTS = {
  SOURCE_LANG: "auto",
  TARGET_LANG: "en",
  NUMS: 5,
  SPEED: 1,
  TYPE: 1,
};
const CHAT_COMPLETION_OBJECT = "chat.completion";
const CHAT_COMPLETION_FINISH_REASON = "stop";

const REST_API_PATH_REGEX = /^\/api\/([^/]+)\/([^/]+)\/?$/i;

const PROVIDER_ALIAS = {
  gg: "google",
  google: "google",
  ms: "microsoft",
  microsoft: "microsoft",
  iciba: "iciba",
  youdao: "youdao",
};

// ─── 模型目录 ─────────────────────────────────────────────────────────────────

const MODELS = [
  { id: "google-tts", object: "model", owned_by: "google", type: "tts", description: "Google TTS — 文字转语音", params: ["input", "voice(语言代码)", "speed"] },
  { id: "google-translate", object: "model", owned_by: "google", type: "chat", description: "Google Translate — 机器翻译", params: ["messages", "source_lang", "target_lang"] },
  { id: "google-dict", object: "model", owned_by: "google", type: "chat", description: "Google Dict — 词典（含更多 dt 字段）", params: ["messages", "source_lang", "target_lang"] },
  { id: "youdao-dictvoice", object: "model", owned_by: "youdao", type: "tts", description: "有道词典发音 — type: 1=英式(默认) 2=美式", params: ["input", "type"] },
  { id: "youdao-dict", object: "model", owned_by: "youdao", type: "chat", description: "有道词典查询", params: ["messages"] },
  { id: "youdao-suggest", object: "model", owned_by: "youdao", type: "chat", description: "有道单词联想", params: ["messages", "nums(默认5)"] },
  { id: "iciba-dictvoice", object: "model", owned_by: "iciba", type: "tts", description: "金山词霸发音 — type: 1=英式(默认) 2=美式", params: ["input", "type"] },
  { id: "iciba-dict", object: "model", owned_by: "iciba", type: "chat", description: "金山词霸词典查询", params: ["messages"] },
  { id: "iciba-suggest", object: "model", owned_by: "iciba", type: "chat", description: "金山词霸单词联想", params: ["messages", "nums(默认5)"] },
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
  const ua = pick(UA_POOL);
  const referer = pick(REFERER_POOL[site] ?? REFERER_POOL.google);
  const origin = referer.replace(/\/$/, "");

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
    "User-Agent": ua,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": pick(LANG_POOL),
    "Accept-Encoding": "gzip, deflate, br",
    // Referer:            referer,
    // Origin:             origin,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    Connection: "keep-alive",
    // IP 来源伪装
    "X-Forwarded-For": forwardedFor,
    "X-Real-IP": ip1,
    "CF-Connecting-IP": ip1,
    "X-Client-IP": ip2,
    "True-Client-IP": ip1,
    // 调用方覆盖字段放最后
    ...extra,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── 响应工具 ──────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

export async function assertResponseIsOK(response, errorName) {
  if (!response.ok) {
    const errorMessage = `${errorName} ${response.status}`;
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const body = await response.json().catch(() => ({}));
      const message = errorMessage + ": " + (body?.message || body?.error || JSON.stringify(body));
      throw new Error(String(message));
    } else if (contentType.includes('text/')) {
      const body = await response.text().catch(() => ({}));
      const message = errorMessage + ": " + body;
      throw new Error(String(message));
    }
    throw new Error(errorMessage);
  }
}

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}

function errResp(message, status = 400) {
  return jsonResp({ error: message, status }, status);
}

function safeJSONStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value ?? "");
  }
}

function estimateTokenCount(text) {
  const normalized = String(text ?? "");
  if (!normalized) return 0;
  return Math.max(1, Math.ceil(normalized.length / 4));
}

function buildChatCompletionResponse(model, promptText, outputText) {
  const normalizedOutput = String(outputText ?? "");
  const promptTokens = estimateTokenCount(promptText);
  const completionTokens = estimateTokenCount(normalizedOutput);

  return jsonResp({
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: CHAT_COMPLETION_OBJECT,
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: normalizedOutput,
        },
        finish_reason: CHAT_COMPLETION_FINISH_REASON,
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  });
}

function withTextAndRaw(text, raw) {
  const normalizedText = String(text ?? "").trim();
  return {
    text: normalizedText || safeJSONStringify(raw),
    raw,
  };
}

function pickGoogleSentenceTranslation(raw) {
  const sentences = raw?.sentences;
  if (!Array.isArray(sentences)) return "";
  return sentences
    .map((item) => item?.trans ?? "")
    .filter(Boolean)
    .join("")
    .trim();
}

function formatGoogleDictText(raw) {
  const lines = [];
  const mainTranslation = pickGoogleSentenceTranslation(raw);
  if (mainTranslation) lines.push(`翻译: ${mainTranslation}`);

  const dictItems = Array.isArray(raw?.dict) ? raw.dict : [];
  for (const item of dictItems) {
    const pos = String(item?.pos ?? "").trim();
    const terms = Array.isArray(item?.terms) ? item.terms.filter(Boolean) : [];
    if (!pos || terms.length === 0) continue;
    lines.push(`${pos}: ${terms.slice(0, 8).join("、")}`);
  }

  const exampleItems = Array.isArray(raw?.examples?.example) ? raw.examples.example : [];
  const firstExample = exampleItems.find((item) => item?.text && item?.translation);
  if (firstExample) {
    lines.push(`例句: ${String(firstExample.text).trim()}`);
    lines.push(`例句翻译: ${String(firstExample.translation).trim()}`);
  }

  return lines.join("\n").trim() || mainTranslation || "";
}

function formatMicrosoftTranslateText(raw) {
  if (!Array.isArray(raw)) return "";
  return raw
    .flatMap((item) => Array.isArray(item?.translations) ? item.translations : [])
    .map((translation) => translation?.text ?? "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

function formatYoudaoSuggestText(raw) {
  const entries = Array.isArray(raw?.data?.entries) ? raw.data.entries : [];
  const lines = entries
    .map((item) => {
      const entry = String(item?.entry ?? "").trim();
      const explain = String(item?.explain ?? "").trim();
      if (!entry) return "";
      return explain ? `${entry}: ${explain}` : entry;
    })
    .filter(Boolean)
    .slice(0, 10);
  return lines.join("\n");
}

function formatIcibaSuggestText(rawList) {
  const list = Array.isArray(rawList) ? rawList : [];
  const lines = list
    .map((item) => {
      const key = String(item?.key ?? item?.word_name ?? "").trim();
      const paraphrase = String(item?.paraphrase ?? "").trim();
      if (!key) return "";
      return paraphrase ? `${key}: ${paraphrase}` : key;
    })
    .filter(Boolean)
    .slice(0, 10);
  return lines.join("\n");
}

function formatYoudaoDictText(raw) {
  const lines = [];
  const word = String(raw?.ec?.word?.["return-phrase"] ?? raw?.ec?.word?.["return_phrase"] ?? raw?.ec?.word?.word ?? raw?.input ?? "").trim();
  const ukPhone = String(raw?.ec?.word?.ukphone ?? "").trim();
  const usPhone = String(raw?.ec?.word?.usphone ?? "").trim();
  if (word) lines.push(`单词: ${word}`);
  if (ukPhone || usPhone) {
    const parts = [];
    if (ukPhone) parts.push(`英 /${ukPhone}/`);
    if (usPhone) parts.push(`美 /${usPhone}/`);
    lines.push(`音标: ${parts.join("  ")}`);
  }

  const trs = Array.isArray(raw?.ec?.word?.trs) ? raw.ec.word.trs : [];
  for (const tr of trs.slice(0, 6)) {
    const pos = String(tr?.pos ?? "").trim();
    const tran = String(tr?.tran ?? "").trim();
    if (!pos && !tran) continue;
    lines.push(`${pos || "释义"} ${tran}`.trim());
  }

  const webTrans = Array.isArray(raw?.ec?.web_trans) ? raw.ec.web_trans : [];
  const webLines = webTrans
    .map((item) => String(item ?? "").trim())
    .filter(Boolean)
    .slice(0, 5);
  if (webLines.length > 0) {
    lines.push(`网络释义: ${webLines.join("；")}`);
  }

  return lines.join("\n").trim();
}

function formatIcibaDictText(raw) {
  const lines = [];
  const wordInfo = raw?.pageProps?.initialReduxState?.word?.wordInfo;
  const baesInfo = wordInfo?.baesInfo;
  const word = String(baesInfo?.word_name ?? "").trim();
  if (word) lines.push(`单词: ${word}`);

  const symbol = baesInfo?.symbols?.[0];
  const phEn = String(symbol?.ph_en ?? "").trim();
  const phAm = String(symbol?.ph_am ?? "").trim();
  if (phEn || phAm) {
    const parts = [];
    if (phEn) parts.push(`英 /${phEn}/`);
    if (phAm) parts.push(`美 /${phAm}/`);
    lines.push(`音标: ${parts.join("  ")}`);
  }

  const partsList = Array.isArray(symbol?.parts) ? symbol.parts : [];
  for (const part of partsList.slice(0, 6)) {
    const partName = String(part?.part ?? "").trim();
    const means = Array.isArray(part?.means) ? part.means.filter(Boolean).slice(0, 6) : [];
    if (!partName && means.length === 0) continue;
    lines.push(`${partName || "释义"} ${means.join("、")}`.trim());
  }

  const sentenceGroups = Array.isArray(wordInfo?.new_sentence) ? wordInfo.new_sentence : [];
  const firstGroup = sentenceGroups.find((group) => Array.isArray(group?.sentences) && group.sentences.length > 0);
  const firstSentence = firstGroup?.sentences?.[0];
  if (firstSentence?.en && firstSentence?.cn) {
    lines.push(`例句: ${String(firstSentence.en).trim()}`);
    lines.push(`例句翻译: ${String(firstSentence.cn).trim()}`);
  }

  return lines.join("\n").trim();
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
  await assertResponseIsOK(res, `下载失败 ${url} → HTTP`);
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
      const url = new URL(request.url);
      const { pathname } = url;
      const method = request.method.toUpperCase();

      if (method === HTTP_METHOD.OPTIONS)
        return new Response(null, { status: 204, headers: CORS });

      if (pathname === PATH.MODELS && method === HTTP_METHOD.GET)
        return jsonResp({ object: "list", data: MODELS });

      const apikey = request.headers.get("Authorization")?.replace("Bearer ", "") 
                  || request.headers.get("X-API-Key")
                  || url.searchParams.get("api_key");
      if (apikey !== env.API_KEY) {
        return errResp('Unauthorization', 401);
      }

      if (isRestApiPath(pathname))
        return await handleRestApi(request, pathname);

      if (pathname === PATH.CHAT && method === HTTP_METHOD.POST)
        return await handleChat(request);

      if (pathname === PATH.SPEECH && method === HTTP_METHOD.POST)
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

  const { model, messages, source_lang = DEFAULTS.SOURCE_LANG, target_lang = DEFAULTS.TARGET_LANG, nums = DEFAULTS.NUMS } = body;

  if (!model) return errResp("缺少 model 字段");

  const text = joinContent(messages);
  if (!text) return errResp("messages 中缺少用户消息");

  try {
    switch (model) {
      case "google-translate": {
        const data = await googleTranslateData(text, source_lang, target_lang);
        return buildChatCompletionResponse(model, text, safeJSONStringify(data));
      }
      case "google-dict": {
        const data = await googleDictData(text, source_lang, target_lang);
        return buildChatCompletionResponse(model, text, safeJSONStringify(data));
      }
      case "youdao-dict": {
        const data = await youdaoDictData(text);
        return buildChatCompletionResponse(model, text, safeJSONStringify(data));
      }
      case "youdao-suggest": {
        const data = await youdaoSuggestData(text, Number(nums));
        return buildChatCompletionResponse(model, text, safeJSONStringify(data));
      }
      case "iciba-dict": {
        const data = await icibaDictData(text);
        return buildChatCompletionResponse(model, text, safeJSONStringify(data));
      }
      case "iciba-suggest": {
        const data = await icibaSuggestData(text, Number(nums));
        return buildChatCompletionResponse(model, text, safeJSONStringify(data));
      }
      case "microsoft-translate": {
        const data = await microsoftTranslateData(messages, source_lang, target_lang);
        return buildChatCompletionResponse(model, text, safeJSONStringify(data));
      }
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

  const { model, input, voice = DEFAULTS.TARGET_LANG, speed = DEFAULTS.SPEED, type = DEFAULTS.TYPE } = body;

  if (!model) return errResp("缺少 model 字段");
  if (!input) return errResp("缺少 input 字段");

  try {
    switch (model) {
      case "google-tts": return await googleTTS(input, voice, Number(speed));
      case "youdao-dictvoice": return await youdaoTTS(input, Number(type));
      case "iciba-dictvoice": return await icibaTTS(input, Number(type));
      default:
        return errResp(`不支持的 TTS 模型: ${model}，请查看 GET /v1/models`);
    }
  } catch (e) {
    return errResp(`上游请求失败: ${e.message}`, 502);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── RESTful 路由 ──────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

function isRestApiPath(pathname) {
  return REST_API_PATH_REGEX.test(pathname);
}

function matchRestApiPath(pathname) {
  const matched = pathname.match(REST_API_PATH_REGEX);
  if (!matched) return null;
  const provider = matched[1].toLowerCase();
  const action = matched[2].toLowerCase();
  const normalizedProvider = PROVIDER_ALIAS[provider];
  if (!normalizedProvider) return null;
  return { provider: normalizedProvider, action };
}

function safeToNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function normalizeText(value) {
  if (typeof value !== "string") return "";
  return value.trim();
}

async function parseOptionalJsonBody(request) {
  if (request.method.toUpperCase() !== HTTP_METHOD.POST) return {};
  try {
    return await request.json();
  } catch {
    return { __invalid_json__: true };
  }
}

function firstNonEmpty(values, fallback = "") {
  for (const value of values) {
    const normalized = normalizeText(value);
    if (normalized) return normalized;
  }
  return fallback;
}

async function buildRestInput(request) {
  const url = new URL(request.url);
  const query = url.searchParams;
  const body = await parseOptionalJsonBody(request);
  if (body?.__invalid_json__) return { error: errResp("请求体必须是合法的 JSON") };

  return {
    text: firstNonEmpty([query.get("text"), body.text]),
    source_lang: firstNonEmpty([query.get("source_lang"), body.source_lang], DEFAULTS.SOURCE_LANG),
    target_lang: firstNonEmpty([query.get("target_lang"), body.target_lang], DEFAULTS.TARGET_LANG),
    speed: safeToNumber(query.get("speed") ?? body.speed, DEFAULTS.SPEED),
    type: safeToNumber(query.get("type") ?? body.type, DEFAULTS.TYPE),
    nums: safeToNumber(query.get("nums") ?? body.nums, DEFAULTS.NUMS),
  };
}

function buildMicrosoftMessages(text) {
  return [{ content: text }];
}

const REST_ROUTE_HANDLER = {
  "google.tts": (input) => googleTTS(input.text, input.target_lang, input.speed),
  "google.translate": (input) => googleTranslate(input.text, input.source_lang, input.target_lang),
  "google.dict": (input) => googleDict(input.text, input.source_lang, input.target_lang),
  "microsoft.translate": (input) => microsoftTranslate(buildMicrosoftMessages(input.text), input.source_lang, input.target_lang),
  "iciba.tts": (input) => icibaTTS(input.text, input.type),
  "iciba.dict": (input) => icibaDict(input.text),
  "iciba.suggest": (input) => icibaSuggest(input.text, input.nums),
  "youdao.tts": (input) => youdaoTTS(input.text, input.type),
  "youdao.dict": (input) => youdaoDict(input.text),
  "youdao.suggest": (input) => youdaoSuggest(input.text, input.nums),
};

async function handleRestApi(request, pathname) {
  const method = request.method.toUpperCase();
  if (method !== HTTP_METHOD.GET && method !== HTTP_METHOD.POST)
    return errResp("REST API 仅支持 GET/POST", 405);

  const route = matchRestApiPath(pathname);
  if (!route) return errResp("不支持的 REST API 路由", 404);

  const routeKey = `${route.provider}.${route.action}`;
  const routeHandler = REST_ROUTE_HANDLER[routeKey];
  if (!routeHandler) return errResp(`不支持的 REST API 路由: /api/${route.provider}/${route.action}`, 404);

  const restInput = await buildRestInput(request);
  if (restInput.error) return restInput.error;
  if (!restInput.text) return errResp("缺少 text 字段");

  try {
    return await routeHandler(restInput);
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
  await assertResponseIsOK(res, "Google TTS HTTP");
  return audioResp(res);
}

async function googleTranslateData(text, sourceLang, targetLang) {
  const url =
    `https://translate.googleapis.com/translate_a/single` +
    `?client=gtx&dj=1&dt=t&dt=at&dt=bd&dt=ex&dt=md&dt=rw&dt=ss&dt=rm` +
    `&q=${encodeURIComponent(text)}` +
    `&sl=${encodeURIComponent(sourceLang)}&source=icon&tk=100000.999999` +
    `&tl=${encodeURIComponent(targetLang)}`;

  const res = await fetch(url, { headers: fakeBrowserHeaders("google") });
  await assertResponseIsOK(res, "Google Translate HTTP");
  const raw = await res.json();
  return withTextAndRaw(pickGoogleSentenceTranslation(raw), raw);
}

async function googleTranslate(text, sourceLang, targetLang) {
  return jsonResp(await googleTranslateData(text, sourceLang, targetLang));
}

async function googleDictData(text, sourceLang, targetLang) {
  const base = await googleTranslateData(text, sourceLang, targetLang);
  return withTextAndRaw(formatGoogleDictText(base.raw), base.raw);
}

async function googleDict(text, sourceLang, targetLang) {
  return jsonResp(await googleDictData(text, sourceLang, targetLang));
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── 有道 ──────────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

async function youdaoTTS(word, type) {
  const safeType = type === 2 ? 2 : 1;
  const url = `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(word)}&type=${safeType}`;

  const res = await fetch(url, { headers: fakeBrowserHeaders("youdao") });
  await assertResponseIsOK(res, "有道 TTS HTTP");
  return audioResp(res);
}

async function youdaoDictData(word) {
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
  await assertResponseIsOK(res, "有道词典 HTTP");
  const raw = await res.json();
  return withTextAndRaw(formatYoudaoDictText(raw), raw);
}

async function youdaoDict(word) {
  return jsonResp(await youdaoDictData(word));
}

async function youdaoSuggestData(word, num) {
  const url =
    `https://dict.youdao.com/suggest` +
    `?num=${num}&ver=3.0&doctype=json&q=${encodeURIComponent(word)}`;

  const res = await fetch(url, { headers: fakeBrowserHeaders("youdao") });
  await assertResponseIsOK(res, "有道 Suggest HTTP");
  const raw = await res.json();
  return withTextAndRaw(formatYoudaoSuggestText(raw), raw);
}

async function youdaoSuggest(word, num) {
  return jsonResp(await youdaoSuggestData(word, num));
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── 金山词霸 ──────────────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

const ICIBA_BASE =
  "https://www.iciba.com/_next/data/SIgDISbkU9OFnSzS3LWHc/word.json";

async function icibaTTS(text, type) {
  const url = `${ICIBA_BASE}?w=${encodeURIComponent(text)}`;
  const res = await fetch(url, { headers: fakeBrowserHeaders("iciba") });
  await assertResponseIsOK(res, "金山词霸词条 HTTP");

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

async function icibaDictData(text) {
  const url = `${ICIBA_BASE}?w=${encodeURIComponent(text)}`;
  const res = await fetch(url, { headers: fakeBrowserHeaders("iciba") });
  await assertResponseIsOK(res, "金山词霸词典 HTTP");
  const raw = await res.json();
  return withTextAndRaw(formatIcibaDictText(raw), raw);
}

async function icibaDict(text) {
  return jsonResp(await icibaDictData(text));
}

async function icibaSuggestData(text, nums) {
  const url =
    `https://dict.iciba.com/dictionary/word/suggestion` +
    `?word=${encodeURIComponent(text)}&nums=${nums}`;

  const res = await fetch(url, { headers: fakeBrowserHeaders("iciba") });
  await assertResponseIsOK(res, "金山词霸 Suggest HTTP");

  const raw = await res.json();
  if (raw.status !== 1) throw new Error("金山词霸 Suggest 返回失败状态");
  return withTextAndRaw(formatIcibaSuggestText(raw.message), raw);
}

async function icibaSuggest(text, nums) {
  return jsonResp(await icibaSuggestData(text, nums));
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── Microsoft Translator ──────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════

async function microsoftTranslateData(messages, sourceLang, targetLang) {
  // Step 1: 获取免费 Bearer Token
  const authRes = await fetch("https://edge.microsoft.com/translate/auth", {
    headers: fakeBrowserHeaders("microsoft"),
  });
  await assertResponseIsOK(authRes, "Microsoft Auth HTTP");
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
  await assertResponseIsOK(translateRes, "Microsoft Translate HTTP");

  const raw = await translateRes.json();
  return withTextAndRaw(formatMicrosoftTranslateText(raw), raw);
}

async function microsoftTranslate(messages, sourceLang, targetLang) {
  return jsonResp(await microsoftTranslateData(messages, sourceLang, targetLang));
}
