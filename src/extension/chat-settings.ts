import { isRecord } from './tools/navigation-input';

export const CHAT_SETTINGS_STORAGE_KEY = 'chatSettings';
export const ANTHROPIC_API_ORIGIN = 'https://api.anthropic.com/*';

export const CHAT_MODELS = [
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1' },
] as const;

export type ChatModel = (typeof CHAT_MODELS)[number]['id'];

export interface ChatSettings {
  apiKey: string;
  model: ChatModel;
}

export const DEFAULT_CHAT_SETTINGS: ChatSettings = { apiKey: '', model: 'claude-sonnet-5-5' };

// The key goes into a request header, so only printable ASCII without spaces can be sent.
const API_KEY_PATTERN = /^[\x21-\x7e]*$/;

function isChatModel(value: unknown): value is ChatModel {
  return CHAT_MODELS.some((model) => model.id === value);
}

export function validApiKey(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return API_KEY_PATTERN.test(trimmed) ? trimmed : undefined;
}

export function parseChatSettings(value: unknown): ChatSettings {
  if (!isRecord(value)) return { ...DEFAULT_CHAT_SETTINGS };
  return {
    apiKey: validApiKey(value.apiKey) ?? DEFAULT_CHAT_SETTINGS.apiKey,
    model: isChatModel(value.model) ? value.model : DEFAULT_CHAT_SETTINGS.model,
  };
}

export async function loadChatSettings(): Promise<ChatSettings> {
  const items = await browser.storage.local.get(CHAT_SETTINGS_STORAGE_KEY);
  return parseChatSettings(items[CHAT_SETTINGS_STORAGE_KEY]);
}

export async function saveChatSettings(settings: ChatSettings): Promise<void> {
  const apiKey = isRecord(settings) ? validApiKey(settings.apiKey) : undefined;
  if (apiKey === undefined || !isChatModel(settings.model)) throw new Error('Invalid chat settings');
  await browser.storage.local.set({ [CHAT_SETTINGS_STORAGE_KEY]: { apiKey, model: settings.model } });
}
