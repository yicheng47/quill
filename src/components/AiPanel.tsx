import { useState, useEffect, useRef } from "react";
import { Sparkles, Send, Loader2 } from "lucide-react";
import Markdown from "react-markdown";
import { useAiChat } from "../hooks/useAiChat";

interface AiPanelProps {
  context?: string;
  onContextConsumed?: () => void;
}

export default function AiPanel({ context, onContextConsumed }: AiPanelProps) {
  const { messages, streaming, send, initialize } = useAiChat();
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Initialize AI on first open
  useEffect(() => {
    initialize();
  }, [initialize]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Handle context from "Ask AI" in context menu — auto-send
  useEffect(() => {
    if (context && !streaming) {
      send(`Explain this passage: "${context}"`);
      onContextConsumed?.();
    }
  }, [context, onContextConsumed, send, streaming]);

  const handleSend = () => {
    if (!input.trim() || streaming) return;
    send(input.trim());
    setInput("");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex flex-col h-full bg-bg-muted">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 h-[63px] border-b border-border shrink-0">
        <Sparkles size={20} className="text-text-muted" />
        <h2 className="text-[20px] font-semibold text-text-primary tracking-[-0.45px] leading-[30px]">
          AI Reading Assistant
        </h2>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-auto px-4 py-4">
        <div className="flex flex-col gap-3">
          {messages.map((msg) =>
            msg.role === "assistant" ? (
              <div
                key={msg.id}
                className="bg-bg-surface border border-border rounded-lg px-[13px] py-[13px] max-w-[85%]"
              >
                {streaming && !msg.content && msg === messages[messages.length - 1] ? (
                  <span className="flex items-center gap-1.5 text-[14px] text-text-muted">
                    <Loader2 size={14} className="animate-spin" />
                    Thinking...
                  </span>
                ) : (
                  <div className="prose prose-sm max-w-none text-[14px] text-text-primary leading-5 tracking-[-0.15px] [&_h1]:text-[16px] [&_h2]:text-[15px] [&_h3]:text-[14px] [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_h1]:mt-3 [&_h1]:mb-1 [&_h2]:mt-3 [&_h2]:mb-1 [&_h3]:mt-2 [&_h3]:mb-1 [&_p]:my-1.5 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0.5 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:italic [&_blockquote]:text-text-muted [&_code]:bg-bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-[13px] [&_pre]:bg-bg-muted [&_pre]:p-3 [&_pre]:rounded-lg [&_pre]:overflow-x-auto [&_strong]:font-semibold [&_em]:italic [&_hr]:border-border [&_a]:text-accent [&_a]:underline">
                    <Markdown>{msg.content}</Markdown>
                    {streaming && msg.content && msg === messages[messages.length - 1] && (
                      <Loader2 size={14} className="inline-block ml-1 animate-spin text-text-muted" />
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div key={msg.id} className="flex justify-end">
                <div className="bg-accent rounded-lg px-[13px] py-[13px] max-w-[85%]">
                  <p className="text-[14px] text-white leading-5 tracking-[-0.15px]">
                    {msg.content}
                  </p>
                </div>
              </div>
            )
          )}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input */}
      <div className="border-t border-border px-4 pt-[17px] pb-4 flex flex-col gap-2">
        <div className="flex gap-2 items-start">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask me anything about what you're reading..."
            rows={2}
            className="flex-1 h-[60px] bg-bg-input rounded-lg px-3 py-2 text-[14px] text-text-primary placeholder:text-text-placeholder tracking-[-0.15px] leading-5 outline-none border border-transparent focus:border-accent resize-none"
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || streaming}
            className={`size-[60px] shrink-0 rounded-lg flex items-center justify-center cursor-pointer bg-accent text-white ${
              !input.trim() || streaming ? "opacity-50" : ""
            }`}
          >
            {streaming ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <Send size={16} />
            )}
          </button>
        </div>
        <p className="text-[12px] text-text-muted">
          Press Enter to send, Shift+Enter for new line
        </p>
      </div>
    </div>
  );
}
