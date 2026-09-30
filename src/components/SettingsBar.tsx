import React from 'react';
import { Settings } from '../types';

interface SettingsBarProps {
  settings: Settings;
  onUpdateSettings: (patch: Partial<Settings>) => void;
  showSysPanel: boolean;
  onToggleSysPanel: () => void;
  onClearChat: () => void;
}

export const SettingsBar: React.FC<SettingsBarProps> = ({
  settings,
  onUpdateSettings,
  showSysPanel,
  onToggleSysPanel,
  onClearChat,
}) => {
  const tempPercent = Math.min(100, Math.max(0, (settings.temperature / 2) * 100));

  return (
    <section id="settingsBar">
      <div className="settings-controls-group">
        {/* Chip 1: Temperature */}
        <div className="settings-chip" title="Độ sáng tạo (Temperature: 0.00 đến 2.00, mặc định: 1.00)">
          <span className="chip-label">Temp:</span>
          <input
            id="tempRange"
            type="range"
            min="0"
            max="2"
            step="0.01"
            value={settings.temperature}
            onChange={(e) => {
              const val = parseFloat(e.target.value);
              if (!isNaN(val)) {
                onUpdateSettings({ temperature: Math.round(val * 100) / 100 });
              }
            }}
            style={{
              width: '75px',
              background: `linear-gradient(to right, #6366f1 0%, #6366f1 ${tempPercent}%, rgba(255, 255, 255, 0.15) ${tempPercent}%, rgba(255, 255, 255, 0.15) 100%)`,
            }}
          />
          <input
            id="tempValInput"
            type="number"
            className="chip-num"
            min="0"
            max="2"
            step="0.01"
            value={settings.temperature}
            onChange={(e) => {
              const val = parseFloat(e.target.value);
              if (!isNaN(val)) {
                const clamped = Math.min(2, Math.max(0, Math.round(val * 100) / 100));
                onUpdateSettings({ temperature: clamped });
              }
            }}
            title="Nhập trực tiếp giá trị Temperature"
          />
        </div>

        {/* Chip 2: Max Tokens */}
        <div className="settings-chip" title="Giới hạn số token tối đa cho câu trả lời">
          <span className="chip-label">Max tokens:</span>
          <input
            id="maxTokensInput"
            type="number"
            className="chip-num"
            value={settings.maxTokens}
            min="1"
            max="1000000"
            step="256"
            style={{ width: '60px' }}
            onChange={(e) => {
              const val = parseInt(e.target.value, 10);
              if (!isNaN(val) && val > 0) {
                onUpdateSettings({ maxTokens: val });
              }
            }}
          />
        </div>

        {/* Chip 3: Stream Toggle */}
        <label className="settings-chip chip-clickable" title="Nhận câu trả lời từng chữ liên tục">
          <input
            id="streamToggle"
            type="checkbox"
            checked={settings.stream}
            onChange={(e) => onUpdateSettings({ stream: e.target.checked })}
          />
          <span>Stream</span>
        </label>

        {/* Chip 4: 18+ Mode */}
        <label
          className={`settings-chip chip-nsfw ${settings.nsfw ? 'active' : ''}`}
          title="Bật/tắt chế độ sáng tạo tự do mở rộng (Creative Mode 18+)"
        >
          <input
            id="nsfwToggle"
            type="checkbox"
            checked={settings.nsfw}
            style={{ accentColor: '#ec4899', cursor: 'pointer' }}
            onChange={(e) => onUpdateSettings({ nsfw: e.target.checked })}
          />
          <span>🔞 18+</span>
        </label>
      </div>

      {/* Action Buttons: System Prompt & Clear Chat */}
      <div className="settings-actions-group">
        <button
          id="toggleSysBtn"
          className="settings-action-btn"
          style={{
            borderColor: showSysPanel ? 'rgba(99, 102, 241, 0.6)' : 'rgba(255, 255, 255, 0.15)',
            color: showSysPanel ? '#c7d2fe' : 'var(--text-secondary)',
            background: showSysPanel ? 'rgba(99, 102, 241, 0.18)' : 'rgba(255, 255, 255, 0.05)',
          }}
          onClick={onToggleSysPanel}
          title="Bật/tắt khung chỉnh sửa System Prompt"
        >
          ⚙️ System prompt {showSysPanel ? '▲' : '▼'}
        </button>

        <button
          id="clearChatBtn"
          className="settings-action-btn danger"
          title="Xoá toàn bộ lịch sử trò chuyện của nhà cung cấp này"
          onClick={onClearChat}
        >
          🗑️ Xoá chat
        </button>
      </div>
    </section>
  );
};
