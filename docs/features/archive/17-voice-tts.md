# 17 — Voice (TTS)

> GitHub Issue: https://github.com/yicheng47/quill/issues/88
> Milestone: 3 (Full AI Integration)

## Motivation

Reading is multi-sensory. Voice brings text to life — especially for language learners hearing pronunciation, or readers who want to listen while following along. Quill already has AI lookup and chat; adding voice closes the loop between reading, understanding, and hearing.

## Scope

### Phase 1 — Select & Read Aloud
- User selects a paragraph (or text range) in the reader, and a "Read aloud" action appears in the context menu / selection toolbar
- TTS plays the selected text using the configured voice model
- Playback controls: play/pause, stop — inline or minimal floating UI
- Works for both EPUB and PDF

### Phase 2 — Lookup Voice
- AI lookup popover gains a speaker button next to the word heading
- Tapping it reads the word (and optionally the definition) aloud
- Useful for pronunciation — especially for foreign-language vocabulary

### Phase 3 — AI Companion Voice
- AI chat responses can be read aloud (speaker button per message, or auto-read toggle)
- The companion's "voice" becomes part of its personality — configurable per-book or globally

### Future (out of scope for now)
- Continuous page/chapter narration (full audiobook mode)
- Voice input (speak to the companion)
- Custom voice cloning

## TTS Provider Architecture

Follow the same multi-provider pattern as AI chat:
- **Settings**: `tts_provider` key (`openai`, `elevenlabs`, `edge`, `local`)
- **Voice selection**: each provider exposes available voices; user picks one in Settings > Voice
- **API keys**: stored in `secrets.db` (same as AI provider keys)
- **Streaming**: prefer streaming TTS APIs where available for low-latency playback

### Provider candidates
| Provider | Streaming | Quality | Cost | Local |
|----------|-----------|---------|------|-------|
| OpenAI TTS | Yes | High | Paid | No |
| ElevenLabs | Yes | Very high | Paid | No |
| Edge TTS | Yes | Good | Free | No |
| Kokoro / local | Depends | Varies | Free | Yes |

## Key Decisions

- Start with OpenAI TTS (simplest, already have API key infrastructure) and Edge TTS (free fallback)
- Audio playback via Web Audio API in the frontend — Rust backend streams audio chunks via Tauri events
- Voice config lives in settings (`tts_provider`, `tts_voice`, `tts_speed`)
- No persistent audio caching in v1 — generate on demand

## Verification

- [ ] Select text → "Read aloud" → hear TTS playback
- [ ] Lookup popover → speaker icon → hear word pronunciation
- [ ] Settings > Voice → switch provider/voice → new voice used
- [ ] Works offline with local TTS provider (if configured)
- [ ] AI chat message → speaker button → hear response read aloud
