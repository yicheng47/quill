import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Bot, BookOpen, Palette, Save } from "lucide-react";
import Button from "../components/ui/Button";
import Select from "../components/ui/Select";
import Input from "../components/ui/Input";
import Toggle from "../components/ui/Toggle";
import Slider from "../components/ui/Slider";
import SaveDialog from "../components/SaveDialog";

export default function SettingsPage() {
  const navigate = useNavigate();
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);

  // AI config
  const [aiEnabled, setAiEnabled] = useState(true);
  const [provider, setProvider] = useState("openai");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("gpt-4");
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState(2000);

  // Reading preferences
  const [fontSize, setFontSize] = useState(16);
  const [fontFamily, setFontFamily] = useState("system");
  const [autoSave, setAutoSave] = useState(true);

  // Appearance
  const [theme, setTheme] = useState("system");

  return (
    <div className="flex flex-col h-screen bg-bg-page">
      {/* Header */}
      <header className="flex items-center justify-between px-page h-16 bg-bg-surface border-b border-border shrink-0">
        <div className="flex items-center gap-4">
          <Button variant="icon" size="md" onClick={() => navigate(-1)}>
            <ArrowLeft size={16} />
          </Button>
          <div>
            <h1 className="text-[18px] font-semibold text-text-primary">Settings</h1>
            <p className="text-[13px] text-text-muted">
              Manage your reading preferences and AI configuration
            </p>
          </div>
        </div>
        <Button
          variant="primary"
          size="md"
          onClick={() => setSaveDialogOpen(true)}
        >
          <Save size={16} />
          Save Changes
        </Button>
      </header>

      {/* Content */}
      <main className="flex-1 overflow-auto">
        <div className="max-w-[560px] mx-auto py-8 px-4 space-y-6">
          {/* AI Assistant Configuration */}
          <section className="bg-bg-surface rounded-xl border border-border p-6">
            <div className="flex items-center gap-2 mb-1">
              <Bot size={20} className="text-text-muted" />
              <h2 className="text-[16px] font-semibold text-text-primary">
                AI Assistant Configuration
              </h2>
            </div>
            <p className="text-[13px] text-text-muted mb-4">
              Configure your AI provider and model preferences for the reading assistant
            </p>

            <div className="space-y-5">
              {/* Enable toggle */}
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-[14px] font-semibold text-text-primary">Enable AI Assistant</p>
                  <p className="text-[13px] text-text-muted">Turn on/off AI-powered reading assistance</p>
                </div>
                <Toggle checked={aiEnabled} onChange={setAiEnabled} />
              </div>

              <div className="h-px bg-border-light" />

              {/* Provider */}
              <Select
                label="AI Provider"
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
              >
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
              </Select>
              <p className="-mt-3 text-[12px] text-text-muted">Choose your preferred AI service provider</p>

              {/* API Key */}
              <div>
                <label className="block text-[14px] font-semibold text-text-primary mb-1.5">
                  API Key
                </label>
                <Input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="sk-..."
                />
                <p className="text-[12px] text-text-muted mt-1.5">
                  Your API key is stored locally and never shared
                </p>
              </div>

              {/* Model */}
              <Select
                label="Model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
              >
                {provider === "openai" ? (
                  <>
                    <option value="gpt-4">gpt-4</option>
                    <option value="gpt-4o">gpt-4o</option>
                    <option value="gpt-4o-mini">gpt-4o-mini</option>
                  </>
                ) : (
                  <>
                    <option value="claude-sonnet">claude-sonnet-4-20250514</option>
                    <option value="claude-haiku">claude-haiku-4-5-20251001</option>
                  </>
                )}
              </Select>
              <p className="-mt-3 text-[12px] text-text-muted">
                Different models offer varying performance and cost
              </p>

              <div className="h-px bg-border-light" />

              {/* Temperature */}
              <Slider
                label="Temperature"
                min={0}
                max={100}
                value={Math.round(temperature * 100)}
                onChange={(v) => setTemperature(v / 100)}
                displayValue={temperature.toFixed(1)}
                hint="Lower = more focused, Higher = more creative"
              />

              {/* Max Response Length */}
              <Slider
                label="Max Response Length"
                min={100}
                max={4000}
                value={maxTokens}
                onChange={setMaxTokens}
                displayValue={`${maxTokens} tokens`}
                hint="Maximum length of AI responses"
              />
            </div>
          </section>

          {/* Reading Preferences */}
          <section className="bg-bg-surface rounded-xl border border-border p-6">
            <div className="flex items-center gap-2 mb-1">
              <BookOpen size={20} className="text-text-muted" />
              <h2 className="text-[16px] font-semibold text-text-primary">
                Reading Preferences
              </h2>
            </div>
            <p className="text-[13px] text-text-muted mb-4">
              Customize your reading experience
            </p>

            <div className="space-y-5">
              {/* Font Size */}
              <Slider
                label="Default Font Size"
                min={12}
                max={28}
                value={fontSize}
                onChange={setFontSize}
                displayValue={`${fontSize}px`}
                hint="Default font size when opening books"
              />

              {/* Font Family */}
              <Select
                label="Font Family"
                value={fontFamily}
                onChange={(e) => setFontFamily(e.target.value)}
              >
                <option value="system">System Default</option>
                <option value="georgia">Georgia</option>
                <option value="palatino">Palatino</option>
                <option value="inter">Inter</option>
                <option value="times">Times New Roman</option>
              </Select>
              <p className="-mt-3 text-[12px] text-text-muted">Choose your preferred reading font</p>

              <div className="h-px bg-border-light" />

              {/* Auto-save */}
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-[14px] font-semibold text-text-primary">Auto-save Progress</p>
                  <p className="text-[13px] text-text-muted">Automatically save your reading position</p>
                </div>
                <Toggle checked={autoSave} onChange={setAutoSave} />
              </div>
            </div>
          </section>

          {/* Appearance */}
          <section className="bg-bg-surface rounded-xl border border-border p-6">
            <div className="flex items-center gap-2 mb-1">
              <Palette size={20} className="text-text-muted" />
              <h2 className="text-[16px] font-semibold text-text-primary">
                Appearance
              </h2>
            </div>
            <p className="text-[13px] text-text-muted mb-4">
              Customize the look and feel of the app
            </p>

            <Select
              label="Theme"
              value={theme}
              onChange={(e) => setTheme(e.target.value)}
            >
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </Select>
            <p className="text-[12px] text-text-muted mt-1.5">Choose your preferred color scheme</p>
          </section>
        </div>
      </main>

      <SaveDialog
        open={saveDialogOpen}
        onCancel={() => setSaveDialogOpen(false)}
        onSave={() => {
          setSaveDialogOpen(false);
          navigate(-1);
        }}
      />
    </div>
  );
}
