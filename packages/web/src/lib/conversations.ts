/**
 * Conversation storage and utility functions for the Jimmy chat.
 * Conversations are keyed by sessionId (not agentId).
 */

export type MediaType = 'image' | 'audio' | 'file'

export interface MediaAttachment {
  type: MediaType
  url: string
  name?: string
  mimeType?: string
  duration?: number
  waveform?: number[]
  size?: number
}

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: number
  media?: MediaAttachment[]
  toolCall?: string
}

export interface Conversation {
  sessionId: string
  messages: Message[]
  lastActivity: number
}

export type ConversationStore = Record<string, Conversation>

const STORAGE_KEY = 'jimmy-conversations'

export function loadConversations(): ConversationStore {
  if (typeof window === 'undefined') return {}
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

export function saveConversations(store: ConversationStore): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  } catch { /* storage full — silently skip */ }
}

export function addMessage(
  store: ConversationStore,
  sessionId: string,
  msg: Message,
): ConversationStore {
  const conv = store[sessionId] || {
    sessionId,
    messages: [],
    lastActivity: Date.now(),
  }
  return {
    ...store,
    [sessionId]: {
      ...conv,
      messages: [...conv.messages, msg],
      lastActivity: Date.now(),
    },
  }
}

/**
 * Extract image / audio URLs from markdown content.
 */
export function parseMedia(content: string): MediaAttachment[] {
  const media: MediaAttachment[] = []

  // Markdown images: ![alt](url)
  const imgRegex =
    /!\[([^\]]*)\]\((https?:\/\/[^)]+\.(jpg|jpeg|png|gif|webp|svg)(\?[^)]*)?)\)/gi
  let m: RegExpExecArray | null
  while ((m = imgRegex.exec(content)) !== null) {
    media.push({ type: 'image', url: m[2], name: m[1] || 'Image' })
  }

  // Bare image URLs not already captured
  const bareImgRegex =
    /(?<!\]\()https?:\/\/\S+\.(jpg|jpeg|png|gif|webp)(\?\S*)?\b/gi
  while ((m = bareImgRegex.exec(content)) !== null) {
    const url = m[0]
    if (!media.find((x) => x.url === url)) {
      media.push({ type: 'image', url })
    }
  }

  // Audio URLs
  const audioRegex = /https?:\/\/\S+\.(mp3|wav|ogg|m4a|aac)(\?\S*)?\b/gi
  while ((m = audioRegex.exec(content)) !== null) {
    media.push({ type: 'audio', url: m[0], name: m[0].split('/').pop() })
  }

  return media
}
