/**
 * Helper to parse raw API error logs into a clean, mobile-friendly structured format
 */
export interface ParsedApiError {
  httpCode: string;
  summary: string;
  hint?: string;
  formattedLog: string;
  rawText: string;
}

export function parseApiError(rawError: string): ParsedApiError {
  const text = (rawError || '').trim();
  if (!text) {
    return {
      httpCode: '',
      summary: 'Không nhận được phản hồi từ máy chủ.',
      formattedLog: '',
      rawText: '',
    };
  }

  let body = text;
  let httpCode = '';
  let hint = '';

  // 1. Extract hint if present: [Gợi ý: ...]
  const hintMatch = body.match(/•?\s*\[(?:Gợi ý|Lưu ý):([^\]]+)\]/i);
  if (hintMatch) {
    hint = hintMatch[1].trim();
    body = body.replace(hintMatch[0], '').trim();
  }

  // 2. Extract HTTP code
  const httpMatch = body.match(/(?:LỖI\s+HTTP|Mã\s+phản\s+hồi\s+HTTP|HTTP|API Error\s*\()\s*(\d{3})/i);
  if (httpMatch) {
    httpCode = `HTTP ${httpMatch[1]}`;
  }

  // 3. Strip URL prefixes from message body for cleaner display
  const urlMatch = body.match(/(?:•\s*(?:API|Địa chỉ API|URL):\s*|tại\s+)(https?:\/\/[^\s\n)]+)/i);
  if (urlMatch) {
    body = body.replace(urlMatch[0], '').trim();
  }
  body = body.replace(/^\[?(?:LỖI\s+HTTP|Mã\s+phản\s+hồi\s+HTTP|HTTP)\s*\d{3}\]?[:\s-]*/i, '').trim();
  body = body.replace(/^(?:Gemini|OpenAI|Anthropic)\s+API Error \(\d{3}\):?\s*/i, '').trim();
  body = body.replace(/•\s*(?:API|Địa chỉ API|URL):\s*https?:\/\/[^\s\n)]+/gi, '').trim();

  // 4. Try parsing JSON if present inside
  let formattedLog = body;
  let parsedJson: any = null;

  try {
    parsedJson = JSON.parse(body);
    formattedLog = JSON.stringify(parsedJson, null, 2);
  } catch {
    const jsonStart = body.indexOf('{');
    const jsonEnd = body.lastIndexOf('}');
    if (jsonStart !== -1 && jsonEnd > jsonStart) {
      try {
        const jsonSub = body.slice(jsonStart, jsonEnd + 1);
        parsedJson = JSON.parse(jsonSub);
        formattedLog = JSON.stringify(parsedJson, null, 2);
      } catch {
        // Keep raw string
      }
    }
  }

  // 5. Build human-friendly concise summary
  let summary = '';
  const lower = body.toLowerCase();

  // Check 402 / OpenRouter credit exhaustion first
  if (
    httpCode === 'HTTP 402' ||
    lower.includes('402') ||
    lower.includes('prompt tokens limit exceeded') ||
    lower.includes('openrouter_credits') ||
    lower.includes('requires more credits') ||
    lower.includes('can only afford') ||
    lower.includes('in_flight_budget_exhausted') ||
    lower.includes('upgrade to a paid account')
  ) {
    summary = 'Tài khoản OpenRouter của bạn đã hết số dư / không đủ credit cho model này (HTTP 402).';
    hint = '💡 Hướng dẫn khắc phục:\n1. Chọn model Miễn Phí của OpenRouter (có đuôi ":free"): ví dụ "meta-llama/llama-3.3-70b-instruct:free", "deepseek/deepseek-r1:free", "google/gemini-2.0-flash-exp:free", "qwen/qwen-2.5-72b-instruct:free".\n2. Nạp thêm credits tại: https://openrouter.ai/settings/credits\n3. Hoặc chuyển sang Preset "Google Gemini" với API Key miễn phí từ aistudio.google.com.';
  } else if (body.includes('API_KEY_SERVICE_BLOCKED') || body.includes('Expected OAuth 2 access token')) {
    summary = 'Mô hình này yêu cầu tài khoản nội bộ (OAuth 2) hoặc API Key bị giới hạn quyền.';
    hint = 'Mô hình bạn chọn (ví dụ antigravity/experimental) không mở cho API Key thông thường. Hãy chọn các model chính thức như gemini-2.5-flash, gemini-2.5-pro, hoặc gemini-1.5-flash.';
  } else if (parsedJson?.error?.message) {
    summary = parsedJson.error.message;
  } else if (parsedJson?.message) {
    summary = parsedJson.message;
  }

  if (!summary) {
    if (httpCode === 'HTTP 401' || lower.includes('401') || lower.includes('unauthorized') || lower.includes('invalid api key')) {
      summary = 'Sai API Key hoặc mã Key đã hết hạn (401 Unauthorized).';
    } else if (httpCode === 'HTTP 403' || lower.includes('403') || lower.includes('forbidden') || lower.includes('permission denied')) {
      summary = 'Bị từ chối quyền truy cập hoặc tài khoản chưa kích hoạt/nạp tiền (403 Forbidden).';
    } else if (httpCode === 'HTTP 404' || lower.includes('404') || lower.includes('not found')) {
      summary = 'Địa chỉ Base URL không tồn tại hoặc sai đường dẫn API (404 Not Found).';
    } else if (httpCode === 'HTTP 429' || lower.includes('429') || lower.includes('quota') || lower.includes('rate limit')) {
      summary = 'Đã hết hạn mức gọi (Quota) hoặc bị nghẽn tần suất (429 Rate Limit / Quota Exceeded).';
    } else if (lower.includes('failed to fetch') || lower.includes('cors') || lower.includes('networkerror')) {
      summary = 'Lỗi kết nối mạng trực tiếp hoặc máy chủ API chặn CORS.';
    } else if (lower.includes('html') || lower.includes('<!doctype')) {
      summary = 'Máy chủ trả về trang web HTML thay vì phản hồi cổng API JSON.';
    } else {
      // First line of error
      summary = body.split('\n')[0]?.slice(0, 140) || 'Lỗi kết nối đến nhà cung cấp API.';
    }
  }

  return {
    httpCode: httpCode || (lower.includes('cors') ? 'CORS' : ''),
    summary,
    hint,
    formattedLog: formattedLog || text,
    rawText: text,
  };
}
