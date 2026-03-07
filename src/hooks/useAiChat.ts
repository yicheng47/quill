import { useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

export function useAiChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const initializedRef = useRef(false);
  const messagesRef = useRef<ChatMessage[]>([]);

  // Keep ref in sync with state
  const updateMessages = (updater: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => {
    setMessages((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      messagesRef.current = next;
      return next;
    });
  };

  const send = useCallback(
    async (content: string, context?: string) => {
      const userMessage: ChatMessage = {
        id: Date.now().toString(),
        role: "user",
        content,
      };

      const assistantId = (Date.now() + 1).toString();
      const assistantMessage: ChatMessage = {
        id: assistantId,
        role: "assistant",
        content: "",
      };

      updateMessages((prev) => [...prev, userMessage, assistantMessage]);

      setStreaming(true);

      // Listen for stream chunks
      unlistenRef.current = await listen<{ delta: string; done: boolean }>(
        "ai-stream-chunk",
        (event) => {
          if (event.payload.done) {
            setStreaming(false);
            unlistenRef.current?.();
            unlistenRef.current = null;
            return;
          }
          updateMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, content: m.content + event.payload.delta }
                : m
            )
          );
        }
      );

      // Build messages for the API from current ref (avoids stale closure)
      // Exclude the static intro and the empty assistant placeholder
      const apiMessages = messagesRef.current
        .filter((m) => m.id !== assistantId && m.id !== "system-intro")
        .map((m) => ({ role: m.role, content: m.content }));

      try {
        await invoke("ai_chat", {
          messages: apiMessages,
          context: context || null,
        });
      } catch (err) {
        setStreaming(false);
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
    []
  );

  const initialize = useCallback(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;

    updateMessages([
      {
        id: "system-intro",
        role: "assistant",
        content: "I'm your reading assistant. Ask me anything about the book you're reading — passages, themes, characters, or vocabulary.",
      },
    ]);
  }, []);

  const reset = useCallback(() => {
    updateMessages([]);
    setStreaming(false);
    initializedRef.current = false;
    unlistenRef.current?.();
    unlistenRef.current = null;
  }, []);

  return { messages, streaming, send, reset, initialize };
}
