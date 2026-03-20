import { useState, useCallback, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  context?: string;
  contextCfi?: string;
  dbId?: string;
}

interface ChatRecord {
  id: string;
  book_id: string;
  title: string;
  model: string | null;
  pinned: boolean;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

interface ChatMsgRecord {
  id: string;
  chat_id: string;
  role: string;
  content: string;
  context: string | null;
  metadata: string | null;
  created_at: string;
}

/** Derive a short title from the user's first message (truncated at word boundary). */
function deriveTitle(userMsg: string): string {
  let title = userMsg
    .replace(/^Explain this passage:\s*"?/i, "")
    .replace(/^Explain\s*/i, "")
    .replace(/"$/, "")
    .trim();
  if (title.length > 40) {
    const cut = title.lastIndexOf(" ", 40);
    title = title.substring(0, cut > 10 ? cut : 40) + "...";
  }
  return title;
}

let msgIdCounter = 0;
function nextMsgId() {
  return `local-${Date.now()}-${++msgIdCounter}`;
}

export function useAiChat(bookId?: string) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [chatId, setChatId] = useState<string | null>(null);
  const [chats, setChats] = useState<ChatRecord[]>([]);

  const unlistenRef = useRef<UnlistenFn | null>(null);
  const initializedBookRef = useRef<string | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  const chatIdRef = useRef<string | null>(null);
  const streamingRef = useRef(false);

  // Cleanup stream listener on unmount
  useEffect(() => {
    return () => {
      unlistenRef.current?.();
      unlistenRef.current = null;
    };
  }, []);

  // Reset initialization when bookId changes
  useEffect(() => {
    if (bookId && initializedBookRef.current && initializedBookRef.current !== bookId) {
      initializedBookRef.current = null;
    }
  }, [bookId]);

  const updateMessages = (updater: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => {
    setMessages((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      messagesRef.current = next;
      return next;
    });
  };

  const refreshChats = useCallback(async (bid: string) => {
    try {
      const result = await invoke<ChatRecord[]>("list_chats", { bookId: bid });
      setChats(result);
      return result;
    } catch {
      return [];
    }
  }, []);

  const loadChat = useCallback(async (id: string) => {
    // Stop any active stream
    if (streamingRef.current) {
      unlistenRef.current?.();
      unlistenRef.current = null;
      setStreaming(false);
      streamingRef.current = false;
    }

    // Set target immediately so rapid clicks can be detected
    setChatId(id);
    chatIdRef.current = id;

    try {
      const msgs = await invoke<ChatMsgRecord[]>("list_chat_messages", { chatId: id });

      // Stale check: if user switched to another chat while we were loading, bail
      if (chatIdRef.current !== id) return;

      const mapped: ChatMessage[] = msgs.map((m) => {
        let contextCfi: string | undefined;
        if (m.metadata) {
          try { contextCfi = JSON.parse(m.metadata).cfi; } catch { /* ignore */ }
        }
        return {
          id: m.id,
          role: m.role as "user" | "assistant",
          content: m.content,
          context: m.context ?? undefined,
          contextCfi,
          dbId: m.id,
        };
      });
      updateMessages(mapped);
    } catch (err) {
      console.error("Failed to load chat messages:", err);
    }
  }, []);

  const createChat = useCallback(async (bid: string) => {
    try {
      const chat = await invoke<ChatRecord>("create_chat", { bookId: bid, title: null, model: null });
      setChatId(chat.id);
      chatIdRef.current = chat.id;
      updateMessages([]);
      await refreshChats(bid);
      return chat;
    } catch (err) {
      console.error("Failed to create chat:", err);
      return null;
    }
  }, [refreshChats]);

  const initialize = useCallback(async (bid?: string) => {
    const targetBook = bid || bookId;
    if (!targetBook) return;
    if (initializedBookRef.current === targetBook) return;
    initializedBookRef.current = targetBook;

    const chatList = await refreshChats(targetBook);
    if (chatList.length > 0) {
      await loadChat(chatList[0].id);
    } else {
      // No chats yet — show empty state without creating a DB record.
      // A chat will be created lazily on first send.
      setChatId(null);
      chatIdRef.current = null;
      updateMessages([]);
    }
  }, [bookId, refreshChats, loadChat]);

  const send = useCallback(
    async (content: string, context?: string, contextCfi?: string) => {
      let currentChatId = chatIdRef.current;
      const currentBookId = bookId;

      // Lazy chat creation: if no chat exists yet, create one now
      if (!currentChatId && currentBookId) {
        const chat = await createChat(currentBookId);
        if (!chat) return;
        currentChatId = chat.id;
      }
      if (!currentChatId) return;

      const userMessage: ChatMessage = {
        id: nextMsgId(),
        role: "user",
        content,
        context,
        contextCfi,
      };

      const assistantId = nextMsgId();
      const assistantMessage: ChatMessage = {
        id: assistantId,
        role: "assistant",
        content: "",
      };

      updateMessages((prev) => [...prev, userMessage, assistantMessage]);
      setStreaming(true);
      streamingRef.current = true;

      // Persist user message
      try {
        const meta = contextCfi ? JSON.stringify({ cfi: contextCfi }) : null;
        const saved = await invoke<ChatMsgRecord>("save_chat_message", {
          chatId: currentChatId,
          role: "user",
          content,
          context: context || null,
          metadata: meta,
        });
        userMessage.dbId = saved.id;
      } catch (err) {
        console.error("Failed to save user message:", err);
      }

      // Accumulate full assistant content for persistence
      let fullContent = "";

      unlistenRef.current = await listen<{ delta: string; done: boolean }>(
        "ai-stream-chunk",
        async (event) => {
          if (event.payload.done) {
            setStreaming(false);
            streamingRef.current = false;
            unlistenRef.current?.();
            unlistenRef.current = null;

            // Persist assistant message
            if (fullContent && !fullContent.startsWith("Error:")) {
              try {
                await invoke("save_chat_message", {
                  chatId: currentChatId,
                  role: "assistant",
                  content: fullContent,
                  context: null,
                  metadata: null,
                });
              } catch (err) {
                console.error("Failed to save assistant message:", err);
              }
            }

            // Auto-title: derive from user message (no AI call to avoid event collision)
            if (currentBookId) {
              try {
                const chat = await invoke<ChatRecord>("get_chat", { chatId: currentChatId });
                if (chat.title === "New chat") {
                  const title = deriveTitle(content);
                  if (title) {
                    await invoke("rename_chat", { chatId: currentChatId, title });
                    await refreshChats(currentBookId);
                  }
                }
              } catch {
                // Ignore auto-title errors
              }
            }

            return;
          }

          fullContent += event.payload.delta;
          updateMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, content: m.content + event.payload.delta }
                : m
            )
          );
        }
      );

      // Build API messages from current ref (avoids stale closure)
      const apiMessages = messagesRef.current
        .filter((m) => m.id !== assistantId)
        .map((m) => ({ role: m.role, content: m.content }));

      try {
        await invoke("ai_chat", {
          messages: apiMessages,
          context: context || null,
        });
      } catch (err) {
        setStreaming(false);
        streamingRef.current = false;
        unlistenRef.current?.();
        unlistenRef.current = null;
        updateMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, content: `Error: ${err}` }
              : m
          )
        );
      }
    },
    [bookId, createChat, refreshChats]
  );

  const deleteChat = useCallback(async (id: string) => {
    const currentBookId = bookId;
    if (!currentBookId) return;

    // Cancel active stream if deleting the streaming chat
    if (id === chatIdRef.current && streamingRef.current) {
      unlistenRef.current?.();
      unlistenRef.current = null;
      setStreaming(false);
      streamingRef.current = false;
    }

    await invoke("delete_chat", { chatId: id });
    const updatedChats = await refreshChats(currentBookId);

    if (id === chatIdRef.current) {
      if (updatedChats.length > 0) {
        await loadChat(updatedChats[0].id);
      } else {
        // No chats left — show empty state, lazy create on next send
        setChatId(null);
        chatIdRef.current = null;
        updateMessages([]);
      }
    }
  }, [bookId, refreshChats, loadChat]);

  const renameChat = useCallback(async (id: string, title: string) => {
    await invoke("rename_chat", { chatId: id, title });
    setChats((prev) => prev.map((c) => c.id === id ? { ...c, title } : c));
  }, []);

  const reset = useCallback(async () => {
    if (!bookId) return;
    // Stop any active stream
    if (streamingRef.current) {
      unlistenRef.current?.();
      unlistenRef.current = null;
      setStreaming(false);
      streamingRef.current = false;
    }
    // Show empty state, lazy create on next send
    setChatId(null);
    chatIdRef.current = null;
    updateMessages([]);
  }, [bookId]);

  return {
    messages,
    streaming,
    send,
    reset,
    initialize,
    chatId,
    chats,
    loadChat,
    createChat,
    deleteChat,
    renameChat,
  };
}
