import React, { useState } from 'react';
import { CodeBlock } from '../components/CodeBlock';
import { Copy, Check } from 'lucide-react';

/**
 * Clean unrendered or stray asterisks in markdown text so they never appear pointlessly.
 * E.g. empty '****', isolated lone '**', unclosed dangling '**', or spaces inside '** bold **'
 */
export function sanitizeMarkdownAsterisks(text: string): string {
  if (!text) return '';

  let res = text;

  // 1. Remove empty or quadrupled asterisks like '****' or '**  **'
  res = res.replace(/\*\*\s*\*\*/g, '');

  // 2. Fix spaces directly inside bold markers: '** text **' -> '**text**'
  res = res.replace(/\*\*\s+([^\n*]+?)\s+\*\*/g, '**$1**');
  res = res.replace(/\*\*\s+([^\n*]+?)\*\*/g, '**$1**');
  res = res.replace(/\*\*([^\n*]+?)\s+\*\*/g, '**$1**');

  // 3. Remove isolated lone '**' surrounded by spaces or newlines (e.g. 'đây là ** đoạn văn')
  res = res.replace(/(^|[\s\n])\*\*(?=[\s\n.,!?;:]|$)/g, '$1');

  // 4. Count remaining '**'. If odd number, remove the trailing dangling unclosed '**'
  const matches = res.match(/\*\*/g);
  if (matches && matches.length % 2 !== 0) {
    const lastIdx = res.lastIndexOf('**');
    if (lastIdx !== -1) {
      res = res.substring(0, lastIdx) + res.substring(lastIdx + 2);
    }
  }

  return res;
}

/**
 * Mini copyable inline code chip
 */
export const InlineCodeChip: React.FC<{ code: string }> = ({ code }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  };

  return (
    <span
      className="inline-cmd-wrapper group"
      onClick={handleCopy}
      title="Bấm để sao chép đoạn mã/lệnh này"
    >
      <code className="inline-code font-mono text-[13px]">{code}</code>
      <span className="inline-flex items-center text-[10px] text-slate-400 group-hover:text-indigo-300 ml-1 transition-colors">
        {copied ? (
          <Check className="w-3 h-3 text-emerald-400" />
        ) : (
          <Copy className="w-3 h-3 opacity-60 group-hover:opacity-100" />
        )}
      </span>
    </span>
  );
};

/**
 * Parse text without codeblocks into React nodes supporting:
 * - **bold** (properly rendered, no raw asterisks)
 * - *italic*
 * - `inline code` (with 1-click copy)
 * - Links (https://...)
 */
export function renderRichText(rawText: string, keyPrefix: string): React.ReactNode[] {
  if (!rawText) return [];

  // Sanitize rogue asterisks
  const clean = sanitizeMarkdownAsterisks(rawText);

  // Split by inline code first
  const codeParts = clean.split(/(`[^`\n]+`)/g);
  const nodes: React.ReactNode[] = [];

  codeParts.forEach((part, partIdx) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      const codeContent = part.slice(1, -1);
      nodes.push(
        <InlineCodeChip
          key={`${keyPrefix}-code-${partIdx}`}
          code={codeContent}
        />
      );
      return;
    }

    // Now parse bold and italic inside non-code text
    // Tokenize **bold**
    const boldParts = part.split(/(\*\*[^*]+?\*\*)/g);
    boldParts.forEach((bPart, bIdx) => {
      if (bPart.startsWith('**') && bPart.endsWith('**') && bPart.length > 4) {
        const boldText = bPart.slice(2, -2);
        nodes.push(
          <strong
            key={`${keyPrefix}-b-${partIdx}-${bIdx}`}
            className="font-bold text-white tracking-wide"
          >
            {boldText}
          </strong>
        );
        return;
      }

      // Tokenize *italic*
      const italicParts = bPart.split(/(\*[^*]+?\*)/g);
      italicParts.forEach((iPart, iIdx) => {
        if (iPart.startsWith('*') && iPart.endsWith('*') && iPart.length > 2) {
          const italicText = iPart.slice(1, -1);
          nodes.push(
            <em
              key={`${keyPrefix}-i-${partIdx}-${bIdx}-${iIdx}`}
              className="italic text-slate-200"
            >
              {italicText}
            </em>
          );
          return;
        }

        // Just regular text
        if (iPart) {
          nodes.push(
            <span key={`${keyPrefix}-t-${partIdx}-${bIdx}-${iIdx}`}>
              {iPart}
            </span>
          );
        }
      });
    });
  });

  return nodes;
}

/**
 * Parses full message content:
 * - Formats full ```lang\ncode``` blocks using <CodeBlock> with 1-click copy
 * - Formats text with **bold**, *italic*, and `inline code`
 */
export function parseAndRenderMessage(content: string): React.ReactNode[] {
  if (!content) return [];

  const segments: React.ReactNode[] = [];
  const codeBlockRegex = /```([a-zA-Z0-9_\-+]*)\n?([\s\S]*?)(?:```|$)/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRegex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      const textBefore = content.slice(lastIndex, match.index);
      segments.push(
        <span key={`txt-${lastIndex}`} className="whitespace-pre-wrap">
          {renderRichText(textBefore, `pre-${lastIndex}`)}
        </span>
      );
    }

    const lang = match[1] ? match[1].trim() : '';
    const code = match[2] !== undefined ? match[2] : '';

    segments.push(
      <CodeBlock
        key={`code-${match.index}`}
        language={lang}
        code={code}
      />
    );

    lastIndex = match.index + match[0].length;
    if (match[0].length === 0) {
      codeBlockRegex.lastIndex++;
    }
  }

  if (lastIndex < content.length) {
    const remainingText = content.slice(lastIndex);
    segments.push(
      <span key={`txt-${lastIndex}`} className="whitespace-pre-wrap">
        {renderRichText(remainingText, `post-${lastIndex}`)}
      </span>
    );
  }

  return segments;
}
