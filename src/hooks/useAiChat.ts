import { useState, useCallback, useRef, useEffect } from "react";
import { invoke, listen, type UnlistenFn } from "../platform";
import { isExactAiSentinel, matchAiSentinel } from "../lib/aiConnections";

export function parseChatMessageContextCfi(metadata: string | null | undefined): string | undefined {
  if (!metadata) return undefined;
  try {
    const parsed = JSON.parse(metadata) as { cfi?: unknown };
    return typeof parsed.cfi === "string" && parsed.cfi ? parsed.cfi : undefined;
  } catch {
    return undefined;
  }
}

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
  const unlisten = await listen<{ delta: string; done: boolean; error?: string | null }>(eventName, (event) => {
    if (event.payload.error) {
      unlisten();
      resolve(null);
      return;
    }
    if (event.payload.done) {
      unlisten();
      title = title.replace(/^["']|["']$/g, "").replace(/[.!]$/, "").trim();
      if (title.length > 50) {
        title = title.substring(0, 50).trim() + "...";
      }
      resolve(title || null);
      return;
    }
    if (
      !event.payload.delta.startsWith("Error:") &&
      !isExactAiSentinel(event.payload.delta)
    ) {
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

let chatRequestCounter = 0;
function nextChatRequestId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `chat-${Date.now()}-${++chatRequestCounter}`;
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
  const [savedMessageSeq, setSavedMessageSeq] = useState(0);

  const unlistenRef = useRef<UnlistenFn | null>(null);
  const activeChannelRef = useRef<string | null>(null);
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

  const cancelActiveStream = useCallback(() => {
    const channel = activeChannelRef.current;
    activeChannelRef.current = null;
    unlistenRef.current?.();
    unlistenRef.current = null;
    if (!streamingRef.current && !channel) return;
    setStreaming(false);
    streamingRef.current = false;
    if (channel) {
      void invoke("ai_cancel", { channel }).catch(() => {});
    }
  }, []);

  // Cleanup stream listener on unmount
  useEffect(() => {
    return () => {
      const channel = activeChannelRef.current;
      activeChannelRef.current = null;
      if (streamingRef.current && channel) {
        streamingRef.current = false;
        void invoke("ai_cancel", { channel }).catch(() => {});
      } else {
        streamingRef.current = false;
      }
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

  // Keep messagesRef current synchronously rather than inside setMessages'
  // updater: React 19 defers updaters until render, so async callers like
  // send() read a stale ref when IPC/listeners resolve before the next paint.
  const updateMessages = (updater: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => {
    const next = typeof updater === "function" ? updater(messagesRef.current) : updater;
    messagesRef.current = next;
    setMessages(next);
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
    cancelActiveStream();

    // Set target immediately so rapid clicks can be detected
    setChatId(id);
    chatIdRef.current = id;

    try {
      const msgs = await invoke<ChatMsgRecord[]>("list_chat_messages", { chatId: id });

      // Stale check: if user switched to another chat while we were loading, bail
      if (chatIdRef.current !== id) return;

      const mapped: ChatMessage[] = msgs.map((m) => ({
        id: m.id,
        role: m.role as "user" | "assistant",
        content: m.content,
        context: m.context ?? undefined,
        contextCfi: parseChatMessageContextCfi(m.metadata),
        dbId: m.id,
      }));
      updateMessages(mapped);
    } catch (err) {
      console.error("Failed to load chat messages:", err);
    }
  }, [cancelActiveStream]);

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

  const initialize = useCallback(async (bid?: string, preferredChatId?: string) => {
    const targetBook = bid || bookId;
    if (!targetBook) { setInitializingSynced(false); return; }
    if (initializedBookRef.current === targetBook && !preferredChatId) { setInitializingSynced(false); return; }
    initializedBookRef.current = targetBook;
    setInitializingSynced(true);

    try {
      const chatList = await refreshChats(targetBook);
      if (chatList.length > 0) {
        const targetId = preferredChatId && chatList.some((c) => c.id === preferredChatId)
          ? preferredChatId
          : chatList[0].id;
        await loadChat(targetId);
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

      if (streamingRef.current) {
        cancelActiveStream();
      }

      const requestId = nextChatRequestId();
      const channel = `ai-stream-chunk-${requestId}`;

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
      activeChannelRef.current = channel;
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
        setSavedMessageSeq((n) => n + 1);
      } catch (err) {
        console.error("Failed to save user message:", err);
      }

      if (chatIdRef.current !== currentChatId || activeChannelRef.current !== channel) return;

      // Accumulate full assistant content for persistence
      let fullContent = "";

      const unlisten = await listen<{ delta: string; done: boolean; error?: string | null }>(
        channel,
        async (event) => {
          if (activeChannelRef.current !== channel) return;
          if (event.payload.error) {
            activeChannelRef.current = null;
            setStreaming(false);
            streamingRef.current = false;
            unlistenRef.current?.();
            unlistenRef.current = null;

            const rawErr = event.payload.error;
            const errorContent =
              matchAiSentinel(rawErr) ??
              (rawErr.startsWith("Error:") ? rawErr : `Error: ${rawErr}`);
            updateMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId ? { ...m, content: errorContent } : m
              )
            );
            return;
          }
          if (event.payload.done) {
            activeChannelRef.current = null;
            setStreaming(false);
            streamingRef.current = false;
            unlistenRef.current?.();
            unlistenRef.current = null;

            // Persist assistant message
            if (
              fullContent &&
              !fullContent.startsWith("Error:") &&
              !isExactAiSentinel(fullContent)
            ) {
              try {
                await invoke("save_chat_message", {
                  chatId: currentChatId,
                  role: "assistant",
                  content: fullContent,
                  context: null,
                  metadata: null,
                });
                setSavedMessageSeq((n) => n + 1);
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

      if (chatIdRef.current !== currentChatId || activeChannelRef.current !== channel) {
        unlisten();
        return;
      }
      unlistenRef.current = unlisten;

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
          chatId: currentChatId,
          requestId,
          messages: apiMessages,
          bookTitle: bookContext?.title ?? null,
          bookAuthor: bookContext?.author ?? null,
          currentChapter: bookContext?.chapter ?? null,
        });

        // Start title generation only after ai_chat passes auth/connection checks.
        // Streaming runs in the background so title generation still runs concurrently.
        if (isNewChat && currentBookId && chatIdRef.current === currentChatId) {
          const titleSource = context || content;
          setTitling(true);
          generateAiTitle(titleSource).then(async (aiTitle) => {
            try {
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
      } catch (err) {
        if (activeChannelRef.current === channel) {
          activeChannelRef.current = null;
          setStreaming(false);
          streamingRef.current = false;
          unlistenRef.current?.();
          unlistenRef.current = null;
        }
        const msg = String(err);
        const errorContent = matchAiSentinel(msg) ?? `Error: ${err}`;
        updateMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, content: errorContent }
              : m
          )
        );
      }
    },
    [bookId, bookContext?.title, bookContext?.author, bookContext?.chapter, cancelActiveStream, createChat, refreshChats]
  );

  const deleteChat = useCallback(async (id: string) => {
    const currentBookId = bookId;
    if (!currentBookId) return;

    // Cancel active stream if deleting the streaming chat
    if (id === chatIdRef.current) {
      cancelActiveStream();
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
  }, [bookId, refreshChats, loadChat, cancelActiveStream]);

  const renameChat = useCallback(async (id: string, title: string) => {
    await invoke("rename_chat", { chatId: id, title });
    setChats((prev) => prev.map((c) => c.id === id ? { ...c, title } : c));
  }, []);

  const reset = useCallback(async () => {
    if (!bookId) return;
    // Stop any active stream
    cancelActiveStream();
    // Show empty state, lazy create on next send
    setChatId(null);
    chatIdRef.current = null;
    updateMessages([]);
  }, [bookId, cancelActiveStream]);

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
    savedMessageSeq,
  };
}
