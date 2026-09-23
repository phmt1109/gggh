import React, { useRef, useEffect, useState } from 'react';
import { Clipboard, Check } from 'lucide-react';

interface ComposerProps {
  input: string;
  onChangeInput: (val: string) => void;
  onSend: () => void;
  onStop: () => void;
  isGenerating: boolean;
  disabled: boolean;
  isNsfw?: boolean;
}

export const Composer: React.FC<ComposerProps> = ({
  input,
  onChangeInput,
  onSend,
  onStop,
  isGenerating,
  disabled,
  isNsfw = false,
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [pasted, setPasted] = useState(false);

  // Auto resize textarea height
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 220)}px`;
    }
  }, [input]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!isGenerating && input.trim() && !disabled) {
        onSend();
      }
    }
  };

  const handlePaste = async () => {
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        const clipText = await navigator.clipboard.readText();
        if (clipText) {
          const newVal = input
            ? `${input}${input.endsWith(' ') || input.endsWith('\n') ? '' : ' '}${clipText}`
            : clipText;
          onChangeInput(newVal);
          setPasted(true);
          setTimeout(() => setPasted(false), 1500);
          if (textareaRef.current) {
            textareaRef.current.focus();
          }
        }
      } else {
        // Fallback for browsers without direct readText permissions
        if (textareaRef.current) {
          textareaRef.current.focus();
          document.execCommand('paste');
        }
      }
    } catch (err) {
      console.warn('Clipboard read error:', err);
      if (textareaRef.current) {
        textareaRef.current.focus();
      }
    }
  };

  return (
    <footer id="composer">
      <div className="input-box-wrapper">
        <textarea
          ref={textareaRef}
          id="input"
          rows={1}
          placeholder="Nhập tin nhắn... (Enter để gửi, Shift+Enter để xuống dòng)"
          value={input}
          onChange={(e) => onChangeInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={isGenerating}
        />

        <button
          type="button"
          className={`btn-paste-inline ${pasted ? 'pasted' : ''}`}
          onClick={handlePaste}
          title="Dán nhanh nội dung từ khay nhớ tạm (Clipboard)"
          disabled={isGenerating}
        >
          {pasted ? (
            <>
              <Check className="w-3.5 h-3.5 text-emerald-400" />
              <span className="text-emerald-400 font-medium">Đã dán</span>
            </>
          ) : (
            <>
              <Clipboard className="w-3.5 h-3.5" />
              <span>Dán</span>
            </>
          )}
        </button>
      </div>

      {isGenerating ? (
        <button
          id="stopBtn"
          type="button"
          className="btn-stop"
          onClick={onStop}
          title="Dừng sinh phản hồi"
        >
          ⏹ Dừng
        </button>
      ) : (
        <button
          id="sendBtn"
          type="button"
          className={`btn-send ${isNsfw ? 'nsfw-active' : ''}`}
          onClick={onSend}
          disabled={disabled || !input.trim()}
          title="Gửi tin nhắn"
        >
          Gửi
        </button>
      )}
    </footer>
  );
};

