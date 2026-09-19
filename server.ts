import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '50mb' }));
  app.use(express.text({ limit: '50mb', type: ['text/*', 'application/json'] }));

  // API Health Check
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  // Endpoint to research/fetch and parse clean text from any URL
  app.get('/api/web-research', async (req, res) => {
    try {
      const targetUrl = req.query.url as string;
      if (!targetUrl) {
        res.status(400).json({ error: 'Missing ?url= query parameter' });
        return;
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      const fetchResp = await fetch(targetUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });
      clearTimeout(timeoutId);

      const html = await fetchResp.text();

      // Extract title
      const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const title = titleMatch ? titleMatch[1].trim() : '';

      // Clean HTML to readable plain text
      const cleanText = html
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
        .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, ' ')
        .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, ' ')
        .replace(/<header\b[^<]*(?:(?!<\/header>)<[^<]*)*<\/header>/gi, ' ')
        .replace(/<aside\b[^<]*(?:(?!<\/aside>)<[^<]*)*<\/aside>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&quot;/gi, '"')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&#39;/gi, "'")
        .replace(/\s+/g, ' ')
        .trim();

      // Limit length to ~8,000 chars to avoid exceeding token limit
      const truncated = cleanText.slice(0, 8000);

      res.json({
        url: targetUrl,
        title,
        content: truncated,
        length: truncated.length,
      });
    } catch (err: any) {
      console.error('Web research error:', err);
      res.status(500).json({ error: 'Failed to fetch webpage', details: err?.message || String(err) });
    }
  });

  // Endpoint to fetch real-time news articles from Google News RSS
  app.get('/api/web-news', async (req, res) => {
    try {
      const q = (req.query.q as string) || '';
      const rssUrl = q
        ? `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=vi&gl=VN&ceid=VN:vi`
        : `https://news.google.com/rss?hl=vi&gl=VN&ceid=VN:vi`;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000);

      const fetchResp = await fetch(rssUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        },
      });
      clearTimeout(timeoutId);

      const xml = await fetchResp.text();
      const items: Array<{ title: string; pubDate: string; source: string; link: string }> = [];
      const itemRegex = /<item>([\s\S]*?)<\/item>/g;
      let match;

      while ((match = itemRegex.exec(xml)) !== null && items.length < 8) {
        const itemBlock = match[1];
        const rawTitle = (itemBlock.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '';
        const rawPubDate = (itemBlock.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) || [])[1] || '';
        const rawSource = (itemBlock.match(/<source[^>]*>([\s\S]*?)<\/source>/i) || [])[1] || '';
        const rawLink = (itemBlock.match(/<link>([\s\S]*?)<\/link>/i) || [])[1] || '';

        const title = rawTitle.replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').trim();
        const source = rawSource.replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').trim();

        if (title) {
          items.push({
            title,
            pubDate: rawPubDate.trim(),
            source,
            link: rawLink.trim(),
          });
        }
      }

      res.json({
        query: q,
        timestamp: new Date().toISOString(),
        items,
      });
    } catch (err: any) {
      console.error('Web news error:', err);
      res.status(500).json({ error: 'Failed to fetch live news', details: err?.message || String(err) });
    }
  });

  // Proxy endpoint to bypass CORS when running locally or in preview
  app.all('/api/proxy', async (req, res) => {
    try {
      const targetUrl = (req.query.url as string) || (req.headers['x-target-url'] as string);
      if (!targetUrl) {
        res.status(400).json({ error: 'Missing target URL parameter (?url=...)' });
        return;
      }

      // Filter and forward headers
      const forwardedHeaders: Record<string, string> = {};
      const forbiddenHeaders = ['host', 'connection', 'content-length', 'transfer-encoding', 'x-target-url'];
      for (const [key, value] of Object.entries(req.headers)) {
        const lowerKey = key.toLowerCase();
        if (!forbiddenHeaders.includes(lowerKey) && typeof value === 'string') {
          forwardedHeaders[lowerKey] = value;
        }
      }

      const method = req.method.toUpperCase();
      const fetchOpts: RequestInit = {
        method,
        headers: forwardedHeaders,
      };

      if (['POST', 'PUT', 'PATCH'].includes(method) && req.body) {
        fetchOpts.body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      }

      const targetResponse = await fetch(targetUrl, fetchOpts);

      // Copy response status
      res.status(targetResponse.status);

      // Copy response headers
      targetResponse.headers.forEach((val, key) => {
        const lower = key.toLowerCase();
        if (!['content-encoding', 'content-length', 'transfer-encoding'].includes(lower)) {
          res.setHeader(key, val);
        }
      });
      res.setHeader('Access-Control-Allow-Origin', '*');

      // If streaming response (e.g. SSE)
      if (targetResponse.body) {
        const reader = targetResponse.body.getReader();
        const pump = async () => {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value) {
                res.write(Buffer.from(value));
              }
            }
            res.end();
          } catch (streamErr) {
            console.error('Proxy stream error:', streamErr);
            res.end();
          }
        };
        await pump();
      } else {
        const data = await targetResponse.text();
        res.send(data);
      }
    } catch (err: any) {
      console.error('Proxy error:', err);
      if (!res.headersSent) {
        res.status(502).json({ error: 'Proxy request failed', details: err?.message || String(err) });
      }
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
