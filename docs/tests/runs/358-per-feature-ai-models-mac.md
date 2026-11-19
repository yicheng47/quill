# #358 Per-feature Codex model and effort — macOS live QA

## 2026-11-19 — candidate `29ef68d`

**Verdict: Passed.** All required macOS live checks in the mission brief passed.

| Item | Value |
| --- | --- |
| Reviewed candidate | `29ef68d10985577ec212a158c390882258a6c447` on `feat/358-per-feature-ai-models`, based on `5263c33` and including #359 |
| Worktree and diff | `/Volumes/samsung/repos/yicheng47/quill/.worktrees/feat-358-per-feature-ai-models`. Clean at both launches. |
| Environment | macOS 26.6.2 (25G83), arm64, Quill 2.0.0 dev, Electron 45.3.3, Node 25.9.0, Codex 0.170.0 signed in |
| Launch and method | `make dev` from the candidate worktree at `localhost:1430`. Native UI via Computer Use. Synthetic `Quill 358 QA.epub` imported into a copy of the development profile. iCloud Sync showed Off and stayed off. |
| Design | Inspected the approved Settings and composer frames from `quill/desktop/specs/358-per-feature-ai-models.pen` through Pencil MCP. |
| Evidence | `/tmp/quill-358-live-qa.u5FCiO/evidence/`. Captures with the signed-in account or the existing Chats sidebar stay in that private local directory. `codex-turns.log` contains the launch log's relevant call and resolution lines. |

### Results

| Check | Verdict | Observation and evidence |
| --- | --- | --- |
| F-1 — default models and effort | Passed | The Codex test profile had zero saved feature or legacy model/effort keys. Settings resolved Look up to GPT-6-Luna / Low, Explain to GPT-6.1 Terra / High, Chat to GPT-6.2-Sol / High, and Translate to GPT-6.1 Terra / Medium. The Explain menu showed separate Model and Reasoning sections, live models, Custom…, and both Defaults selected. `F-1-settings-models.jpg`, `F-1-settings-explain-menu.jpg`. |
| F-2 — turn routing | Passed | The launch log showed `lookup` → `gpt-6-luna/low` for both the definition and passage explanation, `explain` → `gpt-6.1-terra/high`, `translate` → `gpt-6.1-terra/medium`, `chat` → `gpt-6.2-sol/high`, and `generate_title` → `gpt-6-luna/low`. See `codex-turns.log` and the AI-01–AI-04 captures below. |
| F-3 — row isolation and persistence | Passed | Changed only Translate's reasoning from Default (Medium) to Low. Low was still selected after reopening Settings and after a second `make dev` launch. The saved Codex keys had one new Translate effort entry alongside the existing Chat entries. The next Translate turn ran on `gpt-6.1-terra/low` and the Explain control still ran on `gpt-6.1-terra/high`. `F-3-translate-settings-reopened.jpg`, `F-3-translate-menu-after-relaunch.jpg`, `F-3-AI-03-translate-zh-complete.jpg`, `F-3-explain-control.jpg`, `codex-turns.log`. |
| F-4 — shared composer selection | Passed | Both Codex composer menus opened upward with Model and Reasoning sections and the Settings note. Changed Chat to Luna / Medium in Ask Quill. The same conversation in Chats and the Chat row in Settings showed the new pair. The next turn in that Chats thread completed and logged `gpt-6-luna/medium`. `F-4-ask-quill-composer-menu.jpg`, `F-4-chats-composer-menu.jpg`, `F-4-settings-chat-updated.jpg`, `F-4-chats-reply.jpg`, `codex-turns.log`. |
| AI-01 — Look up | Passed | “Lucid” completed with a definition and an In This Passage explanation. Save to Words then displayed Saved. `AI-01-lookup-start.jpg`, `AI-01-lookup-complete.jpg`, `AI-01-word-saved.jpg`. |
| AI-02 — Explain | Passed | “Ice melts in warm air.” completed with an explanation. Quote in Chat inserted the passage into Ask Quill. `AI-02-explain-start.jpg`, `AI-02-explain-complete.jpg`, `AI-02-quote-in-chat.jpg`. |
| AI-03 — Translate | Passed | The default English target completed. The F-3 turn with Simplified Chinese selected produced “门开着。” `AI-03-translate-start.jpg`, `AI-03-translate-complete.jpg`, `F-3-translate-low-start.jpg`, `F-3-AI-03-translate-zh-complete.jpg`. |
| AI-04 — Chat | Passed | Ask Quill completed the reply “Warmth melts ice.” and generated “Ice Melting in Warm Air.” Clicking the message's quoted passage jumped to it and showed the reader's Back to p. 1 control. `AI-04-chat-start.jpg`, `AI-04-chat-title-and-reply.jpg`, `AI-04-open-quoted-passage.jpg`. |
| AI-06 — API UI | Passed | Switching to the OpenAI API-key connection showed one Model row (`gpt-4o`) and Temperature, with no feature or effort rows. Ask Quill displayed passive `gpt-4o` text and the Chats composer had no model picker. `AI-06-api-settings-models.jpg`, `AI-06-api-ask-quill-composer.jpg`, `AI-06-api-chats-composer.jpg`. |
| Wider regression coverage | Skipped | The brief limits this run to the streaming paths, per-feature and composer settings, and API UI compatibility. No API turn or key reveal, language-chip retry, or surrounding-context retranslation was run. |

### Cleanup

Preserved the original `com.wycstudios.quill-dev` and `com.wycstudios.quill-chromium-dev` trees by moving them to same-volume scratch before launching and running against copies. After Quit, restored both original directories and verified their original device and inode IDs. Removed the run's copies and verified port 1430 was free and the original iCloud marker was absent. Quill wrote its normal development logs to the separate macOS log directory.
