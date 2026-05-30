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
  created_at: number;
  updated_at: number;
}

interface ChatMsgRecord {
  id: string;
  chat_id: string;
  role: string;
  content: string;
  context: string | null;
  metadata: string | null;
  created_at: number;
  updated_at: number;
}

/** Derive a short title from the user's first message (truncated at word boundary). */
/** Fallback: truncate user message into a short title. */
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

/** Generate a chat title using a dedicated AI call with per-request event channel.
 *  Titles from the user's first message alone so it can run concurrently with
 *  the response stream instead of waiting for it to finish. */
async function generateAiTitle(
  userMsg: string,
): Promise<string | null> {
  const requestId = `title-${Date.now()}`;
  const eventName = `ai-title-chunk-${requestId}`;

  let title = "";
  let resolveFn: (val: string | null) => void;
  const promise = new Promise<string | null>((r) => { resolveFn = r; });
  let done = false;

  const timeout = setTimeout(() => {
    if (!done) { done = true; resolve(null); }
  }, 15000);

  function resolve(val: string | null) {
    if (done) return;
    done = true;
    clearTimeout(timeout);
    resolveFn(val);
  }

  // Register listener BEFORE invoking the command
  const unlisten = await listen<{ delta: string; done: boolean }>(eventName, (event) => {
    if (event.payload.done) {
      unlisten();
      title = title.replace(/^["']|["']$/g, "").replace(/[.!]$/, "").trim();
      if (title.length > 50) {
        title = title.substring(0, 50).trim() + "...";
      }
      resolve(title || null);
      return;
    }
    if (!event.payload.delta.startsWith("Error:")) {
      title += event.payload.delta;
    }
  });

  // Fire the command (returns immediately, streaming happens in background)
  invoke("ai_generate_title", {
    userMessage: userMsg,
    assistantMessage: "",
    requestId,
  }).catch(() => {
    unlisten();
    resolve(null);
  });

  return promise;
}

let msgIdCounter = 0;
function nextMsgId() {
  return `local-${Date.now()}-${++msgIdCounter}`;
}

interface BookContext {
  title?: string;
  author?: string;
  chapter?: string;
}

export function useAiChat(bookId?: string, bookContext?: BookContext) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [titling, setTitling] = useState(false);
  // True from mount until the first initialize() resolves. Consumers gate
  // sending on this so a message can't be sent (and lazily create a *new*
  // chat) before the existing session chat has loaded.
  const [initializing, setInitializing] = useState(true);
  const [chatId, setChatId] = useState<string | null>(null);
  const [chats, setChats] = useState<ChatRecord[]>([]);

  const unlistenRef = useRef<UnlistenFn | null>(null);
  const initializedBookRef = useRef<string | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  const chatIdRef = useRef<string | null>(null);
  const streamingRef = useRef(false);
  const initializingRef = useRef(true);

  // Keep the ref in lockstep with the state so send() (which reads refs to
  // avoid stale closures) can refuse while initialization is in flight.
  const setInitializingSynced = (v: boolean) => {
    initializingRef.current = v;
    setInitializing(v);
  };

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
      // Mark book as initialized so a later initialize() call won't reload a stale chat.
      initializedBookRef.current = bid;
      await refreshChats(bid);
      return chat;
    } catch (err) {
      console.error("Failed to create chat:", err);
      return null;
    }
  }, [refreshChats]);

  const initialize = useCallback(async (bid?: string) => {
    const targetBook = bid || bookId;
    if (!targetBook) { setInitializingSynced(false); return; }
    if (initializedBookRef.current === targetBook) { setInitializingSynced(false); return; }
    initializedBookRef.current = targetBook;
    setInitializingSynced(true);

    try {
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
    } finally {
      setInitializingSynced(false);
    }
  }, [bookId, refreshChats, loadChat]);

  /* eslint-disable react-hooks/preserve-manual-memoization */
  const send = useCallback(
    async (content: string, context?: string, contextCfi?: string) => {
      // Refuse while the session chat is still loading — otherwise the lazy
      // chat-creation path below would spawn a *new* chat and miss the
      // existing one. Belt-and-suspenders alongside the UI gate.
      if (initializingRef.current) return;

      let currentChatId = chatIdRef.current;
      const currentBookId = bookId;

      // Lazy chat creation: if no chat exists yet, create one now
      const isNewChat = !currentChatId;
      if (!currentChatId && currentBookId) {
        const chat = await createChat(currentBookId);
        if (!chat) return;
        currentChatId = chat.id;
      }
      if (!currentChatId) return;

      // New chat: generate the title from the user's message, concurrently with
      // the response stream (not after it), showing a loading state until it
      // lands. Falls back to a truncated title if the AI call fails.
      if (isNewChat && currentBookId) {
        const titleSource = context || content;
        setTitling(true);
        generateAiTitle(titleSource).then(async (aiTitle) => {
          try {
            // Only auto-title if the chat is still untitled — the user (or a
            // synced rename) may have renamed it while generation was pending.
            const chat = await invoke<ChatRecord>("get_chat", { chatId: currentChatId });
            if (chat.title === "New chat") {
              const title = aiTitle || deriveTitle(titleSource);
              if (title) {
                await invoke("rename_chat", { chatId: currentChatId, title });
                await refreshChats(currentBookId);
              }
            }
          } catch { /* ignore */ } finally {
            setTitling(false);
          }
        });
      }

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
      // Include each message's context inline so the AI sees all quoted passages
      const apiMessages = messagesRef.current
        .filter((m) => m.id !== assistantId)
        .map((m) => ({
          role: m.role,
          content: m.context
            ? `[Selected passage: "${m.context}"]\n\n${m.content}`
            : m.content,
        }));

      try {
        await invoke("ai_chat", {
          messages: apiMessages,
          bookTitle: bookContext?.title ?? null,
          bookAuthor: bookContext?.author ?? null,
          currentChapter: bookContext?.chapter ?? null,
        });
      } catch (err) {
        setStreaming(false);
        streamingRef.current = false;
        unlistenRef.current?.();
        unlistenRef.current = null;
        const errorContent = String(err).includes("AI_NOT_CONFIGURED")
          ? "AI_NOT_CONFIGURED"
          : `Error: ${err}`;
        updateMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, content: errorContent }
              : m
          )
        );
      }
    },
    [bookId, bookContext?.title, bookContext?.author, bookContext?.chapter, createChat, refreshChats]
  );
  /* eslint-enable react-hooks/preserve-manual-memoization */

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
    titling,
    initializing,
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
