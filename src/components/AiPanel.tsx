import { useState } from "react";
import { Sparkles, Send } from "lucide-react";

interface Message {
  id: string;
  role: "assistant" | "user";
  content: string;
}

const initialMessages: Message[] = [
  {
    id: "1",
    role: "assistant",
    content:
      "Hello! I'm your reading assistant. I can help you understand the content, answer questions, summarize sections, and more. What would you like to know?",
  },
];

export default function AiPanel() {
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [input, setInput] = useState("");

  const handleSend = () => {
    if (!input.trim()) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      role: "user",
      content: input.trim(),
    };

    const aiResponse: Message = {
      id: (Date.now() + 1).toString(),
      role: "assistant",
      content:
        "This is a mock response. In the full implementation, this will connect to your configured AI provider to answer questions about the book.",
    };

    setMessages((prev) => [...prev, userMessage, aiResponse]);
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
                <p className="text-[14px] text-text-primary leading-5 tracking-[-0.15px]">
                  {msg.content}
                </p>
              </div>
            ) : (
              <div key={msg.id} className="flex justify-end">
                <div className="bg-dark rounded-lg px-[13px] py-[13px] max-w-[85%]">
                  <p className="text-[14px] text-white leading-5 tracking-[-0.15px]">
                    {msg.content}
                  </p>
                </div>
              </div>
            ),
          )}
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
            disabled={!input.trim()}
            className={`size-[60px] shrink-0 rounded-lg flex items-center justify-center cursor-pointer bg-dark text-white ${
              !input.trim() ? "opacity-50" : ""
            }`}
          >
            <Send size={16} />
          </button>
        </div>
        <p className="text-[12px] text-text-muted">
          Press Enter to send, Shift+Enter for new line
        </p>
      </div>
    </div>
  );
}
