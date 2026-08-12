export interface CodexModel {
  slug: string;
  display_name: string;
  description: string;
  supported_reasoning_levels: string[];
}

export const CODEX_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max", "ultra"];

// Keep in sync with fallback_models() in src-tauri/src/ai/codex_models.rs.
export const CURATED_CODEX_MODELS: CodexModel[] = [
  {
    slug: "gpt-5.6-sol",
    display_name: "GPT-5.6-Sol",
    description: "Latest frontier agentic coding model.",
    supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"],
  },
  {
    slug: "gpt-5.6-terra",
    display_name: "GPT-5.6-Terra",
    description: "Balanced agentic coding model for everyday work.",
    supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max", "ultra"],
  },
  {
    slug: "gpt-5.6-luna",
    display_name: "GPT-5.6-Luna",
    description: "Fast and affordable agentic coding model.",
    supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    slug: "gpt-5.5",
    display_name: "GPT-5.5",
    description: "Frontier model for complex coding, research, and real-world work.",
    supported_reasoning_levels: ["low", "medium", "high", "xhigh"],
  },
  {
    slug: "gpt-5.4",
    display_name: "GPT-5.4",
    description: "Strong model for everyday coding.",
    supported_reasoning_levels: ["low", "medium", "high", "xhigh"],
  },
  {
    slug: "gpt-5.4-mini",
    display_name: "GPT-5.4-Mini",
    description: "Small, fast, and cost-efficient model for simpler coding tasks.",
    supported_reasoning_levels: ["low", "medium", "high", "xhigh"],
  },
  {
    slug: "gpt-5.3-codex-spark",
    display_name: "GPT-5.3-Codex-Spark",
    description: "Ultra-fast coding model.",
    supported_reasoning_levels: ["low", "medium", "high", "xhigh"],
  },
];
