import { ApiFormat, ChatMessage, JailbreakStrategy, NetworkTransport, Provider, Settings } from '../types';
import { addApiLog } from './logger';
import { enrichPromptWithWebResearch } from './webResearch';
import {
  ASSISTANT_PREFILL,
  getDynamicMandateTail,
  getRealtimeContextPrompt,
  getWebSearchInstructionPrompt,
  JAILBREAK_PROMPTS,
  MANDATE_TAIL,
  NON_CHAT_MODELS_REGEX,
  NSFW_CORE,
  REFUSAL_REGEX,
  retryNudge,
} from '../constants';

export function detectFormat(baseUrl: string): ApiFormat {
  const url = (baseUrl || '').toLowerCase();
  if (url.includes('anthropic')) return 'anthropic';
  if (url.includes('generativelanguage') || url.includes('gemini') || url.includes('google')) return 'gemini';
  return 'openai';
}

export function filterModels(models: string[], filterChat: boolean): string[] {
  if (!filterChat) return models;
  return models.filter((m) => !NON_CHAT_MODELS_REGEX.test(m));
}

export function trimContext(messages: ChatMessage[], limit: number): ChatMessage[] {
  if (limit <= 0 || messages.length <= limit) return [...messages];
  const sliced = messages.slice(-limit);
  // Ensure trimmed context always starts with a user message
  while (sliced.length > 0 && sliced[0].role !== 'user') {
    sliced.shift();
  }
  return sliced;
}

export function getActiveSystem(settings: Settings): string {
  if (settings.nsfw) {
    const supplement = settings.systemNSFW.trim();
    const chosenStrategy = settings.jailbreakStrategy || 'extreme_compliance';
    const strategyPrompt = JAILBREAK_PROMPTS[chosenStrategy] || JAILBREAK_PROMPTS.extreme_compliance;
    const corePrompt = `${NSFW_CORE}\n\n${strategyPrompt}`;
    return supplement ? `${corePrompt}\n\n[USER CUSTOM SCENARIO/ROLEPLAY]:\n${supplement}` : corePrompt;
  }
  return settings.systemNormal.trim();
}

/**
 * Helper to safely parse JSON or throw a descriptive error if HTML/text was received
 */
export async function safeParseJson(res: Response, contextLabel: string = 'API'): Promise<any> {
  const text = await res.text();
  const trimmed = text.trim();
  if (trimmed.startsWith('<') || trimmed.toLowerCase().startsWith('<!doctype')) {
    throw new Error(
      `Máy chủ trả về trang HTML thay vì dữ liệu JSON (${contextLabel}). Có thể do URL không hợp lệ hoặc không có proxy backend.`
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Phản hồi từ ${contextLabel} không phải định dạng JSON hợp lệ: ${trimmed}`);
  }
}

/**
 * Universal API fetch supporting Direct Fetch, Built-in Backend Proxy, and Public CORS Fallback
 */
export async function apiFetch(
  url: string,
  options: RequestInit,
  settings?: Settings | NetworkTransport
): Promise<Response> {
  const finalUrl = url;

  // 1. If running inside Perchance engine
  if (typeof (window as any).root?.superFetch === 'function') {
    return (window as any).root.superFetch(finalUrl, options);
  }

  // 2. Direct browser fetch
  try {
    const res = await fetch(finalUrl, options);
    // If direct fetch returns successful response or standard HTTP status, return it
    if (res.status > 0) {
      return res;
    }
  } catch {
    // Network or CORS error on direct fetch -> Proceed to proxy fallbacks
  }

  // 3. Fallback to built-in backend proxy (/api/proxy)
  try {
    const proxyUrl = `/api/proxy?url=${encodeURIComponent(finalUrl)}`;
    const proxyRes = await fetch(proxyUrl, options);
    if (proxyRes.status > 0) {
      return proxyRes;
    }
  } catch {
    // Backend proxy not reachable (e.g. static standalone html)
  }

  // 4. Fallback for standalone HTML files using CORS proxies (for GET requests)
  if (options.method === 'GET' || !options.method) {
    try {
      const corsProxyUrl = `https://corsproxy.io/?url=${encodeURIComponent(finalUrl)}`;
      const corsRes = await fetch(corsProxyUrl, options);
      if (corsRes.ok) {
        return corsRes;
      }
    } catch {
      // Ignore and throw descriptive error below
    }
  }

  throw new Error(
    `Không thể kết nối đến máy chủ API (${finalUrl}). Vui lòng kiểm tra kết nối mạng hoặc thử lại với API key hợp lệ.`
  );
}

/**
 * Fetch available models for a given provider
 */
export async function fetchProviderModels(
  provider: Provider,
  settingsOrTransport?: Settings | NetworkTransport
): Promise<string[]> {
  const format = provider.format || detectFormat(provider.baseUrl);
  let baseUrl = provider.baseUrl.replace(/\/+$/, '');
  const rawApiKey = (provider.apiKey || '').trim().replace(/^["']|["']$/g, '');

  const standardGeminiModels = [
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite',
    'gemini-2.0-pro-exp-02-05',
    'gemini-2.0-flash-thinking-exp-01-21',
    'gemini-1.5-pro',
    'gemini-1.5-flash',
    'gemini-1.5-flash-8b',
    'gemini-1.0-pro',
  ];

  const standardClaudeModels = [
    'claude-3-7-sonnet-20250219',
    'claude-3-5-sonnet-20241022',
    'claude-3-5-haiku-20241022',
    'claude-3-opus-20240229',
    'claude-3-sonnet-20240229',
    'claude-3-haiku-20240307',
  ];

  // Special multi-strategy resolver for Google Gemini (fetches all real-time models)
  if (format === 'gemini' || baseUrl.includes('generativelanguage') || baseUrl.includes('gemini')) {
    let cleanBase = baseUrl;
    if (!cleanBase.includes('/v1')) {
      cleanBase = `${cleanBase}/v1beta`;
    }
    cleanBase = cleanBase.replace(/\/models$/, '');

    // Strategy 1: Header x-goog-api-key with pagination & pageSize=100 to get ALL models
    try {
      const isOAuth = rawApiKey.startsWith('AQ.') || rawApiKey.startsWith('ya29.');
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (isOAuth) {
        headers['Authorization'] = `Bearer ${rawApiKey}`;
      } else if (rawApiKey) {
        headers['x-goog-api-key'] = rawApiKey;
      }

      let list: string[] = [];
      let pageToken = '';
      let pagesFetched = 0;

      do {
        const pageParam = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
        const targetUrl1 = `${cleanBase}/models?pageSize=100${pageParam}`;
        const res1 = await apiFetch(targetUrl1, { method: 'GET', headers }, settingsOrTransport);
        if (res1.ok) {
          const data1 = await safeParseJson(res1, 'danh sách models (gemini header)');
          if (Array.isArray(data1?.models)) {
            for (const m of data1.models) {
              if (
                m.name &&
                (!m.supportedGenerationMethods ||
                  m.supportedGenerationMethods.includes('generateContent') ||
                  m.supportedGenerationMethods.includes('bidiGenerateContent'))
              ) {
                list.push(m.name.replace(/^models\//, ''));
              }
            }
          }
          pageToken = data1?.nextPageToken || '';
          pagesFetched++;
        } else {
          break;
        }
      } while (pageToken && pagesFetched < 5);

      if (list.length > 0) {
        const unique = Array.from(new Set(list)).sort((a, b) => a.localeCompare(b));
        addApiLog({
          type: 'scan',
          provider: 'GEMINI',
          format: 'gemini',
          endpoint: `${cleanBase}/models`,
          status: 'ok',
          httpCode: 200,
          logText: `Thành công: Đã dò tìm được toàn bộ ${unique.length} mô hình Gemini theo thời gian thực (từ mới nhất đến cũ nhất).`,
        });
        return unique;
      }
    } catch {
      // Continue to Strategy 2
    }

    // Strategy 2: URL query param ?key= with pageSize=100
    if (rawApiKey && !rawApiKey.startsWith('AQ.') && !rawApiKey.startsWith('ya29.')) {
      try {
        let list: string[] = [];
        let pageToken = '';
        let pagesFetched = 0;

        do {
          const pageParam = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
          const targetUrl2 = `${cleanBase}/models?pageSize=100&key=${encodeURIComponent(rawApiKey)}${pageParam}`;
          const res2 = await apiFetch(targetUrl2, { method: 'GET', headers: { Accept: 'application/json' } }, settingsOrTransport);
          if (res2.ok) {
            const data2 = await safeParseJson(res2, 'danh sách models (gemini query)');
            if (Array.isArray(data2?.models)) {
              for (const m of data2.models) {
                if (
                  m.name &&
                  (!m.supportedGenerationMethods ||
                    m.supportedGenerationMethods.includes('generateContent') ||
                    m.supportedGenerationMethods.includes('bidiGenerateContent'))
                ) {
                  list.push(m.name.replace(/^models\//, ''));
                }
              }
            }
            pageToken = data2?.nextPageToken || '';
            pagesFetched++;
          } else {
            break;
          }
        } while (pageToken && pagesFetched < 5);

        if (list.length > 0) {
          const unique = Array.from(new Set(list)).sort((a, b) => a.localeCompare(b));
          addApiLog({
            type: 'scan',
            provider: 'GEMINI',
            format: 'gemini',
            endpoint: `${cleanBase}/models`,
            status: 'ok',
            httpCode: 200,
            logText: `Thành công: Đã dò tìm được toàn bộ ${unique.length} mô hình Gemini theo thời gian thực qua tham số ?key=.`,
          });
          return unique;
        }
      } catch {
        // Continue to Strategy 3
      }
    }

    // Strategy 3: OpenAI-compatible endpoint /openai/models with Bearer auth
    if (rawApiKey) {
      try {
        const targetUrl3 = `${cleanBase}/openai/models`;
        const res3 = await apiFetch(
          targetUrl3,
          {
            method: 'GET',
            headers: {
              Accept: 'application/json',
              Authorization: `Bearer ${rawApiKey}`,
            },
          },
          settingsOrTransport
        );
        if (res3.ok) {
          const data3 = await safeParseJson(res3, 'danh sách models (gemini openai)');
          const listItems = Array.isArray(data3?.data) ? data3.data : [];
          const list: string[] = listItems.map((it: any) => String(it.id || it.name || '')).filter(Boolean);
          if (list.length > 0) {
            const unique: string[] = Array.from(new Set<string>(list)).sort((a, b) => a.localeCompare(b));
            addApiLog({
              type: 'scan',
              provider: 'GEMINI',
              format: 'gemini',
              endpoint: targetUrl3,
              status: 'ok',
              httpCode: res3.status,
              logText: `Thành công: Đã nhận danh sách ${unique.length} mô hình Gemini qua endpoint OpenAI tương thích.`,
            });
            return unique;
          }
        }
      } catch {
        // Continue to Strategy 4
      }
    }

    // Strategy 4: Automatic Fallback for API keys where Google blocks ListModels
    addApiLog({
      type: 'scan',
      provider: 'GEMINI',
      format: 'gemini',
      endpoint: `${cleanBase}/models`,
      status: 'ok',
      httpCode: 200,
      logText: `Đã tự động nạp sẵn ${standardGeminiModels.length} mô hình Gemini chính thức (gemini-2.5-flash, gemini-2.5-pro, gemini-2.0-flash, gemini-1.5-flash...) để bỏ qua giới hạn ListModels của Google và sẵn sàng trò chuyện ngay lập tức.`,
    });
    return standardGeminiModels;
  }

  // Anthropic Claude
  if (format === 'anthropic' || baseUrl.includes('anthropic.com')) {
    try {
      const targetUrl = `${baseUrl.replace(/\/models$/, '')}/models`;
      const headers: Record<string, string> = {
        Accept: 'application/json',
        'anthropic-version': '2023-06-01',
      };
      if (rawApiKey) {
        headers['x-api-key'] = rawApiKey;
      }
      const res = await apiFetch(targetUrl, { method: 'GET', headers }, settingsOrTransport);
      if (res.ok) {
        const data = await safeParseJson(res, 'danh sách models (anthropic)');
        const listItems = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
        const models: string[] = listItems.map((it: any) => String(it.id || it.name || it)).filter(Boolean);
        if (models.length > 0) {
          const unique = Array.from(new Set(models)).sort((a, b) => a.localeCompare(b));
          addApiLog({
            type: 'scan',
            provider: 'ANTHROPIC',
            format: 'anthropic',
            endpoint: targetUrl,
            status: 'ok',
            httpCode: 200,
            logText: `Thành công: Đã nhận danh sách ${unique.length} mô hình Claude từ API.`,
          });
          return unique;
        }
      }
    } catch {
      // Fallback below
    }

    addApiLog({
      type: 'scan',
      provider: 'ANTHROPIC',
      format: 'anthropic',
      endpoint: baseUrl,
      status: 'ok',
      httpCode: 200,
      logText: `Đã nạp sẵn ${standardClaudeModels.length} mô hình Claude chính thức (Claude 3.7 Sonnet, Claude 3.5 Sonnet, Claude 3.5 Haiku, Opus...).`,
    });
    return standardClaudeModels;
  }

  // Normalize base URL for OpenAI-compatible formats
  baseUrl = baseUrl.replace(/\/models$/, '');
  const targetUrl = `${baseUrl}/models`;
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };

  if (rawApiKey) {
    headers['Authorization'] = `Bearer ${rawApiKey}`;
  }

  try {
    const res = await apiFetch(targetUrl, { method: 'GET', headers }, settingsOrTransport);
    if (res.ok) {
      const data = await safeParseJson(res, `danh sách models (${format})`);
      const models: string[] = [];

      const list = Array.isArray(data?.data)
        ? data.data
        : Array.isArray(data?.models)
        ? data.models
        : Array.isArray(data)
        ? data
        : [];

      for (const item of list) {
        if (typeof item === 'string') {
          models.push(item);
        } else if (item && typeof item.id === 'string') {
          models.push(item.id);
        } else if (item && typeof item.name === 'string') {
          models.push(item.name.replace(/^models\//, ''));
        } else if (item && typeof item.model === 'string') {
          models.push(item.model);
        }
      }

      if (models.length > 0) {
        const unique = Array.from(new Set(models)).sort((a, b) => a.localeCompare(b));
        addApiLog({
          type: 'scan',
          provider: format.toUpperCase(),
          format,
          endpoint: targetUrl,
          status: 'ok',
          httpCode: res.status,
          logText: `Thành công: Đã nhận danh sách ${unique.length} mô hình AI.`,
        });
        return unique;
      }
    }
  } catch {
    // If request fails, attempt known provider model fallback before throwing
  }

  // Known fallback catalogs for OpenAI-compatible providers
  const lowerUrl = baseUrl.toLowerCase();
  let fallbackModels: string[] = [];

  if (lowerUrl.includes('deepseek.com')) {
    fallbackModels = ['deepseek-chat', 'deepseek-reasoner'];
  } else if (lowerUrl.includes('groq.com')) {
    fallbackModels = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768', 'gemma2-9b-it', 'deepseek-r1-distill-llama-70b'];
  } else if (lowerUrl.includes('openai.com')) {
    fallbackModels = ['gpt-4o', 'gpt-4o-mini', 'gpt-4.5-preview', 'o3-mini', 'o1', 'chatgpt-4o-latest'];
  } else if (lowerUrl.includes('openrouter.ai')) {
    fallbackModels = ['deepseek/deepseek-r1', 'deepseek/deepseek-chat', 'anthropic/claude-3.5-sonnet', 'openai/gpt-4o', 'meta-llama/llama-3.3-70b-instruct'];
  } else if (lowerUrl.includes('mistral.ai')) {
    fallbackModels = ['mistral-large-latest', 'mistral-small-latest', 'codestral-latest', 'pixtral-large-latest'];
  } else if (lowerUrl.includes('x.ai')) {
    fallbackModels = ['grok-2-latest', 'grok-2-vision-latest', 'grok-beta'];
  } else if (lowerUrl.includes('together.xyz') || lowerUrl.includes('together.ai')) {
    fallbackModels = ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'deepseek-ai/DeepSeek-R1', 'mistralai/Mixtral-8x7B-Instruct-v0.1'];
  } else if (lowerUrl.includes('perplexity.ai')) {
    fallbackModels = ['sonar', 'sonar-pro', 'sonar-reasoning'];
  } else if (lowerUrl.includes('cerebras.ai')) {
    fallbackModels = ['llama3.3-70b', 'llama3.1-8b'];
  } else if (lowerUrl.includes('fireworks.ai')) {
    fallbackModels = ['accounts/fireworks/models/deepseek-r1', 'accounts/fireworks/models/llama-v3p3-70b-instruct'];
  } else if (lowerUrl.includes('nvidia.com')) {
    fallbackModels = ['meta/llama-3.3-70b-instruct', 'deepseek-ai/deepseek-r1'];
  } else if (lowerUrl.includes('moonshot.cn')) {
    fallbackModels = ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'];
  }

  if (fallbackModels.length > 0) {
    addApiLog({
      type: 'scan',
      provider: format.toUpperCase(),
      format,
      endpoint: targetUrl,
      status: 'ok',
      httpCode: 200,
      logText: `Đã tự động nạp ${fallbackModels.length} mô hình chính thức của nhà cung cấp. Sẵn sàng trò chuyện!`,
    });
    return fallbackModels;
  }

  // If completely unknown endpoint and failed
  throw new Error(
    `Không thể lấy danh sách mô hình từ ${targetUrl}. Hãy kiểm tra lại API Key hoặc Base URL của bạn.`
  );
}

export interface ChatExecuteParams {
  provider: Provider;
  model: string;
  messages: ChatMessage[];
  settings: Settings;
  onDelta: (text: string, fullText: string) => void;
  abortSignal?: AbortSignal;
  retryAttempt?: number;
}

export interface ChatExecuteResult {
  fullText: string;
  isRefusal: boolean;
}

/**
 * Execute chat request with anti-refusal detection and Gemini safety fallback
 */
export async function executeChat(params: ChatExecuteParams): Promise<ChatExecuteResult> {
  const { provider, model, messages, settings, onDelta, abortSignal, retryAttempt = 0 } = params;
  const format = provider.format || detectFormat(provider.baseUrl);
  const baseUrl = provider.baseUrl.replace(/\/+$/, '');
  const apiKey = (provider.apiKey || '').trim();

  // Prepare trimmed context
  const trimmed = trimContext(messages, settings.contextLimit);

  // If NSFW is ON: calculate dynamic jailbreak strategy rotation for retries
  let activeSystemPrompt = getActiveSystem(settings);
  if (settings.nsfw && retryAttempt > 0) {
    const strategies: JailbreakStrategy[] = ['adaptive', 'deep_narrative', 'hypothetical_author', 'extreme_compliance'];
    const rotatedStrategy = strategies[retryAttempt % strategies.length];
    const rotatedPrompt = JAILBREAK_PROMPTS[rotatedStrategy] || JAILBREAK_PROMPTS.extreme_compliance;
    activeSystemPrompt = `${rotatedPrompt}\n\n${NSFW_CORE}`;
  }

  // Tự động neo thời gian thực tế chính xác và chế độ tìm kiếm web (khắc phục AI bị giới hạn năm cũ)
  const realtimeContext = getRealtimeContextPrompt();
  const searchPrompt = settings.webSearch ? `\n\n${getWebSearchInstructionPrompt()}` : '';
  activeSystemPrompt = `${realtimeContext}${searchPrompt}\n\n${activeSystemPrompt}`;

  // Dynamic mandate tail and real-time web research attached to the last user message
  const payloadMessages = await Promise.all(
    trimmed.map(async (m, idx) => {
      let content = m.content;
      const isLastUser = m.role === 'user' && idx === trimmed.length - 1;
      if (isLastUser) {
        // Tự động phân tích research trang web bất kỳ hoặc cập nhật tin tức trực tiếp nếu câu hỏi liên quan
        try {
          content = await enrichPromptWithWebResearch(content, abortSignal);
        } catch (researchErr) {
          console.warn('Lỗi phân tích web research:', researchErr);
        }

        if (settings.nsfw) {
          content += getDynamicMandateTail(m.content, retryAttempt);
          if (retryAttempt > 0) {
            content += retryNudge(retryAttempt);
          }
        } else {
          const lower = m.content.trim().toLowerCase();
          if (lower.length <= 40 || /^(xin chào|chào|chào bạn|hello|hi|hey|alo|ơi|bạn ơi|có đó không)/i.test(lower)) {
            content += `\n\n[LƯU Ý ĐỘ DÀI: Người dùng đang chào hỏi hoặc nói chuyện ngắn. Bạn BẮT BUỘC chỉ trả lời 1-2 câu ngắn gọn, tự nhiên như con người trò chuyện. TUYỆT ĐỐI KHÔNG viết một đoạn văn dài dòng khi chưa được yêu cầu.]`;
          }
        }

        // Trợ giúp thời gian thực tế nếu người dùng hỏi về ngày, giờ, năm nay hoặc tin tức
        const lowerQuery = m.content.toLowerCase();
        if (/hôm nay|bây giờ|ngày mấy|thứ mấy|năm nay|mấy giờ|thời gian|hiện tại|mới nhất|tin tức|thời sự|sự kiện|thời tiết/i.test(lowerQuery)) {
          const now = new Date();
          const dateStr = `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;
          const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
          content += `\n\n[THỜI GIAN THỰC ĐỂ TRẢ LỜI: Lúc này là ${timeStr}, ngày ${dateStr}, năm ${now.getFullYear()}. Sử dụng mốc thời gian thực này để trả lời chính xác.]`;
        }
      }
      return { role: m.role, content };
    })
  );

  const stream = settings.stream;

  let fullResponse = '';

  if (format === 'gemini') {
    fullResponse = await callGemini({
      baseUrl,
      apiKey,
      model,
      systemPrompt: activeSystemPrompt,
      messages: payloadMessages,
      settings,
      stream,
      onDelta,
      abortSignal,
      retryWithNoSafety: false,
    });
  } else if (format === 'anthropic') {
    fullResponse = await callAnthropic({
      baseUrl,
      apiKey,
      model,
      systemPrompt: activeSystemPrompt,
      messages: payloadMessages,
      settings,
      stream,
      onDelta,
      abortSignal,
    });
  } else {
    // OpenAI format
    fullResponse = await callOpenAI({
      baseUrl,
      apiKey,
      model,
      systemPrompt: activeSystemPrompt,
      messages: payloadMessages,
      settings,
      stream,
      onDelta,
      abortSignal,
    });
  }

  const checkSlice = fullResponse.slice(0, 350).toLowerCase();
  const isRefusal =
    settings.nsfw &&
    (fullResponse.trim().length === 0 ||
      (REFUSAL_REGEX.test(checkSlice) && fullResponse.length < 500));

  return {
    fullText: fullResponse,
    isRefusal,
  };
}

/**
 * OpenAI Chat completion handler (Streaming & Sync)
 */
async function callOpenAI(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  messages: { role: string; content: string }[];
  settings: Settings;
  stream: boolean;
  onDelta: (chunk: string, accumulated: string) => void;
  abortSignal?: AbortSignal;
}): Promise<string> {
  const { baseUrl, apiKey, model, systemPrompt, messages, settings, stream, onDelta, abortSignal } = opts;

  const formattedMessages: { role: string; content: string }[] = [];
  if (systemPrompt) {
    formattedMessages.push({ role: 'system', content: systemPrompt });
  }
  for (const m of messages) {
    formattedMessages.push({ role: m.role, content: m.content });
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: stream ? 'text/event-stream, application/json' : 'application/json',
  };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const body: any = {
    model,
    messages: formattedMessages,
    temperature: settings.temperature,
    max_tokens: settings.maxTokens,
    stream,
  };

  const res = await apiFetch(
    `${baseUrl}/chat/completions`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: abortSignal,
    },
    settings.transport
  );

  if (!res.ok) {
    const errText = await res.text().catch(() => '');

    // Auto-Recovery for HTTP 402 (Insufficient credits or max_tokens exceeds affordability on OpenRouter/Together)
    if (res.status === 402 || errText.includes('requires more credits') || errText.includes('can only afford')) {
      const affordMatch = errText.match(/can only afford (\d+)/i);
      const affordableTokens = affordMatch
        ? Math.max(64, parseInt(affordMatch[1], 10) - 20)
        : Math.max(128, Math.min(512, Math.floor((body.max_tokens || 2048) / 3)));

      if (affordableTokens && affordableTokens < (body.max_tokens || 8192) && !(opts as any)._retried402) {
        console.warn(`[Auto-Recovery 402] Tự động giảm max_tokens xuống ${affordableTokens} để phù hợp với số dư tài khoản.`);
        return callOpenAI({
          ...opts,
          settings: {
            ...settings,
            maxTokens: affordableTokens,
          },
          _retried402: true,
        } as any);
      }
    }

    addApiLog({
      type: 'chat',
      provider: 'OpenAI',
      format: 'openai',
      endpoint: `${baseUrl}/chat/completions`,
      status: 'err',
      httpCode: res.status,
      logText: errText || 'Không có phản hồi nội dung từ máy chủ',
    });
    const cleanLog = errText ? errText.trim() : 'Máy chủ từ chối yêu cầu';
    throw new Error(`[LỖI HTTP ${res.status}]: ${cleanLog}\n• API: ${baseUrl}/chat/completions`);
  }

  if (!stream || !res.body) {
    const data = await safeParseJson(res, 'OpenAI completions');
    const content = data?.choices?.[0]?.message?.content || '';
    onDelta(content, content);
    return content;
  }

  // Handle SSE streaming
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let accumulated = '';
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine || trimmedLine.startsWith(':')) continue;

      if (trimmedLine.startsWith('data:')) {
        const dataStr = trimmedLine.slice(5).trim();
        if (dataStr === '[DONE]') continue;

        try {
          const parsed = JSON.parse(dataStr);
          const delta = parsed?.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta.length > 0) {
            accumulated += delta;
            onDelta(delta, accumulated);
          }
        } catch {
          // ignore partial json
        }
      }
    }
  }

  return accumulated;
}

/**
 * Anthropic Messages handler (Streaming & Sync)
 */
async function callAnthropic(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  messages: { role: string; content: string }[];
  settings: Settings;
  stream: boolean;
  onDelta: (chunk: string, accumulated: string) => void;
  abortSignal?: AbortSignal;
}): Promise<string> {
  const { baseUrl, apiKey, model, systemPrompt, messages, settings, stream, onDelta, abortSignal } = opts;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
    Accept: stream ? 'text/event-stream, application/json' : 'application/json',
  };
  if (apiKey) {
    headers['x-api-key'] = apiKey;
    headers['Authorization'] = `Bearer ${apiKey}`; // for Perchance superFetch proxy
  }

  const formattedMessages = messages.map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content,
  }));

  // Assistant prefill technique for Anthropic (Forces continuation without refusal)
  // Only use prefill if it's NOT a greeting or brief talk (so it does not write an essay on 'xin chào')
  const lastUserText = (messages[messages.length - 1]?.content || '').trim().toLowerCase();
  const isGreetingMsg =
    lastUserText.length <= 40 ||
    /^(xin chào|chào|chào bạn|hello|hi|hey|alo|ơi|bạn ơi)/i.test(lastUserText);
  const usePrefill = settings.nsfw && (settings.assistantPrefill ?? true) && !isGreetingMsg;
  if (usePrefill) {
    formattedMessages.push({
      role: 'assistant',
      content: ASSISTANT_PREFILL,
    });
  }

  const body: any = {
    model,
    messages: formattedMessages,
    max_tokens: settings.maxTokens || 2048,
    temperature: settings.temperature,
    stream,
  };
  if (systemPrompt) {
    body.system = systemPrompt;
  }

  const res = await apiFetch(
    `${baseUrl}/messages`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: abortSignal,
    },
    settings.transport
  );

  if (!res.ok) {
    const errText = await res.text().catch(() => '');

    // Auto-recovery for credit/token limit errors
    if (res.status === 402 || errText.includes('max_tokens') || errText.includes('credit')) {
      const affordMatch = errText.match(/can only afford (\d+)/i);
      const affordableTokens = affordMatch
        ? Math.max(64, parseInt(affordMatch[1], 10) - 20)
        : Math.max(128, Math.min(512, Math.floor((body.max_tokens || 2048) / 2)));

      if (affordableTokens && affordableTokens < (body.max_tokens || 8192) && !(opts as any)._retried402) {
        console.warn(`[Auto-Recovery Anthropic 402] Giảm max_tokens xuống ${affordableTokens}`);
        return callAnthropic({
          ...opts,
          settings: {
            ...settings,
            maxTokens: affordableTokens,
          },
          _retried402: true,
        } as any);
      }
    }

    addApiLog({
      type: 'chat',
      provider: 'Anthropic',
      format: 'anthropic',
      endpoint: `${baseUrl}/messages`,
      status: 'err',
      httpCode: res.status,
      logText: errText || 'Không có phản hồi nội dung từ máy chủ',
    });
    const cleanLog = errText ? errText.trim() : 'Máy chủ từ chối yêu cầu';
    throw new Error(`[LỖI HTTP ${res.status}]: ${cleanLog}\n• API: ${baseUrl}/messages`);
  }

  if (!stream || !res.body) {
    const data = await safeParseJson(res, 'Anthropic messages');
    let text = '';
    if (Array.isArray(data.content)) {
      text = data.content.map((c: any) => c.text || '').join('');
    }
    onDelta(text, text);
    return text;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let accumulated = '';
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine || trimmedLine.startsWith(':')) continue;

      if (trimmedLine.startsWith('data:')) {
        const dataStr = trimmedLine.slice(5).trim();
        try {
          const parsed = JSON.parse(dataStr);
          if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
            const chunk = parsed.delta.text;
            accumulated += chunk;
            onDelta(chunk, accumulated);
          }
        } catch {
          // ignore
        }
      }
    }
  }

  return accumulated;
}

/**
 * Gemini generateContent handler with 18+ BLOCK_NONE safety settings and auto safety-fallback
 */
async function callGemini(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  messages: { role: string; content: string }[];
  settings: Settings;
  stream: boolean;
  onDelta: (chunk: string, accumulated: string) => void;
  abortSignal?: AbortSignal;
  retryWithNoSafety?: boolean;
  retryWithNoTools?: boolean;
}): Promise<string> {
  const {
    baseUrl,
    apiKey,
    model,
    systemPrompt,
    messages,
    settings,
    stream,
    onDelta,
    abortSignal,
    retryWithNoSafety,
    retryWithNoTools,
  } = opts;

  // Clean model name
  const cleanModel = model.replace(/^models\//, '');

  let cleanBaseUrl = baseUrl.replace(/\/+$/, '');
  if (!cleanBaseUrl.includes('/v1')) {
    cleanBaseUrl = `${cleanBaseUrl}/v1beta`;
  }
  cleanBaseUrl = cleanBaseUrl.replace(/\/models$/, '');

  const endpoint = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
  const cleanKey = apiKey.trim().replace(/^["']|["']$/g, '');
  const isToken = cleanKey.startsWith('AQ.') || cleanKey.startsWith('ya29.');

  // Convert messages to Gemini format
  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const body: any = {
    contents,
    generationConfig: {
      temperature: settings.temperature,
      maxOutputTokens: settings.maxTokens,
    },
  };

  // Google Search Grounding: tìm kiếm web thời gian thực (Tắt khi ở chế độ 18+ để không kích hoạt bộ lọc kiểm duyệt bổ sung của Google Search)
  if (settings.webSearch !== false && !settings.nsfw && !retryWithNoTools) {
    body.tools = [{ google_search: {} }];
  }

  if (systemPrompt) {
    body.systemInstruction = {
      parts: [{ text: systemPrompt }],
    };
  }

  // 18+ safety settings (standard official Gemini v1beta categories: BLOCK_NONE)
  if (settings.nsfw && !retryWithNoSafety) {
    body.safetySettings = [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_NONE' },
    ];
  }

  // Helper function to send request
  const executeGeminiRequest = async (authMode: 'header' | 'query') => {
    let requestUrl = `${cleanBaseUrl}/models/${cleanModel}:${endpoint}`;
    const reqHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: stream ? 'text/event-stream, application/json' : 'application/json',
    };

    if (isToken) {
      reqHeaders['Authorization'] = `Bearer ${cleanKey}`;
    } else if (authMode === 'header') {
      if (cleanKey) reqHeaders['x-goog-api-key'] = cleanKey;
    } else {
      const sep = endpoint.includes('?') ? '&' : '?';
      requestUrl = `${cleanBaseUrl}/models/${cleanModel}:${endpoint}${cleanKey ? `${sep}key=${encodeURIComponent(cleanKey)}` : ''}`;
    }

    const response = await apiFetch(
      requestUrl,
      {
        method: 'POST',
        headers: reqHeaders,
        body: JSON.stringify(body),
        signal: abortSignal,
      },
      settings.transport
    );

    return { response, requestUrl };
  };

  // Attempt 1: Header method (Google official recommendation, avoids duplicate credential conflicts)
  let { response: res, requestUrl: url } = await executeGeminiRequest('header');

  // If 401 or authentication error, try Attempt 2: Query param method
  if (!res.ok && !isToken && (res.status === 401 || res.status === 403)) {
    const checkText = await res.clone().text().catch(() => '');
    if (
      checkText.includes('UNAUTHENTICATED') ||
      checkText.includes('API_KEY_SERVICE_BLOCKED') ||
      checkText.includes('invalid authentication credentials')
    ) {
      const retryResult = await executeGeminiRequest('query');
      if (retryResult.response.ok) {
        res = retryResult.response;
        url = retryResult.requestUrl;
      }
    }
  }

  // If still fails with 401/403/API_KEY_SERVICE_BLOCKED, try Attempt 3: Official OpenAI-compatible endpoint
  if (!res.ok && (res.status === 401 || res.status === 403)) {
    const checkText = await res.clone().text().catch(() => '');
    if (checkText.includes('API_KEY_SERVICE_BLOCKED') || checkText.includes('UNAUTHENTICATED')) {
      try {
        const openaiUrl = `${cleanBaseUrl}/openai`;
        return await callOpenAI({
          baseUrl: openaiUrl,
          apiKey: cleanKey,
          model: cleanModel,
          systemPrompt,
          messages,
          settings,
          stream,
          onDelta,
          abortSignal,
        });
      } catch {
        // Continue to error reporting below if OpenAI format fails as well
      }
    }
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    // Check if error is model not found or restricted model (HTTP 404, 400, or 401 API_KEY_SERVICE_BLOCKED for internal models)
    if (
      (res.status === 404 || res.status === 400 || (res.status === 401 && (errText.includes('API_KEY_SERVICE_BLOCKED') || cleanModel.includes('antigravity'))) || errText.toLowerCase().includes('not found') || errText.toLowerCase().includes('is not supported')) &&
      !cleanModel.includes('gemini-2.5-flash') &&
      !cleanModel.includes('gemini-1.5-flash') &&
      !(opts as any)._retriedModel
    ) {
      console.warn(`[Gemini Fallback] Model ${cleanModel} không khả dụng với API Key này, tự động chuyển sang gemini-2.5-flash`);
      return callGemini({
        ...opts,
        model: 'gemini-2.5-flash',
        _retriedModel: true,
      } as any);
    }

    // Check if error is tools/googleSearch related on Gemini (HTTP 400)
    if (!retryWithNoTools && (res.status === 400 || errText.toLowerCase().includes('tool') || errText.toLowerCase().includes('search') || errText.toLowerCase().includes('googlesearch'))) {
      return callGemini({
        ...opts,
        retryWithNoTools: true,
      });
    }
    // Check if error is safetySettings or invalid argument related on Gemini (HTTP 400)
    if (!retryWithNoSafety && (res.status === 400 || errText.toLowerCase().includes('safety') || errText.toLowerCase().includes('invalid_argument'))) {
      // Retry without safety settings
      return callGemini({
        ...opts,
        retryWithNoSafety: true,
      });
    }
    addApiLog({
      type: 'chat',
      provider: 'Google Gemini',
      format: 'gemini',
      endpoint: url,
      status: 'err',
      httpCode: res.status,
      logText: errText || 'Không có phản hồi nội dung từ máy chủ',
    });
    const cleanLog = errText ? errText.trim() : 'Máy chủ từ chối yêu cầu';
    throw new Error(`[LỖI HTTP ${res.status}]: ${cleanLog}\n• API: ${url}`);
  }

  if (!stream || !res.body) {
    const data = await safeParseJson(res, 'Gemini generateContent');
    const firstCandidate = data?.candidates?.[0];
    const parts = firstCandidate?.content?.parts;
    let text = '';
    if (Array.isArray(parts)) {
      text = parts.map((p: any) => p?.text || '').join('');
    } else {
      text = firstCandidate?.content?.parts?.[0]?.text || '';
    }
    if (!text && firstCandidate?.finishReason === 'SAFETY') {
      // If blocked by safety finish reason, return empty so anti-refusal or wrapper can handle
      console.warn('Gemini response blocked by finishReason SAFETY');
    }
    onDelta(text, text);
    return text;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let accumulated = '';
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine || trimmedLine.startsWith(':')) continue;

      if (trimmedLine.startsWith('data:')) {
        const dataStr = trimmedLine.slice(5).trim();
        try {
          const parsed = JSON.parse(dataStr);
          const firstCandidate = parsed?.candidates?.[0];
          const parts = firstCandidate?.content?.parts;
          if (Array.isArray(parts)) {
            for (const part of parts) {
              const candidateText = part?.text;
              if (typeof candidateText === 'string') {
                if (candidateText.startsWith(accumulated) && candidateText.length > accumulated.length) {
                  const delta = candidateText.slice(accumulated.length);
                  accumulated = candidateText;
                  onDelta(delta, accumulated);
                } else if (!accumulated.endsWith(candidateText)) {
                  accumulated += candidateText;
                  onDelta(candidateText, accumulated);
                }
              }
            }
          }
        } catch {
          // ignore
        }
      }
    }
  }

  return accumulated;
}
