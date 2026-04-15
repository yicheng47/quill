//! Event schema — the wire format every mutating command writes into the
//! per-device log and every replay tick consumes.
//!
//! An `Event` is one line of JSON in `<device>.jsonl`. It has a fixed
//! envelope (`id`, `ts`, `device`, `v`) plus a tagged body discriminated by
//! the `type` field. Unknown top-level fields are captured in `extra` so a
//! future schema version can add metadata without breaking old readers that
//! re-serialize the event back into a snapshot.
//!
//! Timestamps are `i64` unix milliseconds, matching the DB after migration
//! 009. The `id` is a ULID string — its leading 48 bits encode the same
//! millisecond, so sorting by `id` is equivalent to sorting by `(ts, tiebreak)`
//! within a single device.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Schema version carried on every event. Bump when adding new fields that
/// old clients cannot safely ignore.
pub const EVENT_SCHEMA_VERSION: u32 = 1;

/// One log line. Fields after `v` come from the tagged body and any unknown
/// future fields land in `extra`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Event {
    pub id: String,
    pub ts: i64,
    pub device: String,
    pub v: u32,
    #[serde(flatten)]
    pub body: EventBody,
    #[serde(flatten, default, skip_serializing_if = "Map::is_empty")]
    pub extra: Map<String, Value>,
}

/// One variant per mutating command. The tag name on the wire is the
/// dotted string in `#[serde(rename = "...")]` — it must match the names
/// iOS and future clients will write, so don't change them casually.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", content = "payload", rename_all = "snake_case")]
pub enum EventBody {
    #[serde(rename = "book.import")]
    BookImport(BookImportPayload),
    #[serde(rename = "book.delete")]
    BookDelete { id: String },
    #[serde(rename = "book.progress.set")]
    BookProgressSet {
        book: String,
        progress: i32,
        cfi: Option<String>,
    },
    #[serde(rename = "book.status.set")]
    BookStatusSet { book: String, status: String },
    #[serde(rename = "book.metadata.set")]
    BookMetadataSet {
        book: String,
        field: String,
        value: Value,
    },

    #[serde(rename = "highlight.add")]
    HighlightAdd(HighlightPayload),
    #[serde(rename = "highlight.delete")]
    HighlightDelete { id: String },
    #[serde(rename = "highlight.color.set")]
    HighlightColorSet { id: String, color: String },
    #[serde(rename = "highlight.note.set")]
    HighlightNoteSet {
        id: String,
        note: Option<String>,
    },

    #[serde(rename = "bookmark.add")]
    BookmarkAdd(BookmarkPayload),
    #[serde(rename = "bookmark.delete")]
    BookmarkDelete { id: String },

    #[serde(rename = "vocab.add")]
    VocabAdd(VocabPayload),
    #[serde(rename = "vocab.mastery.set")]
    VocabMasterySet {
        id: String,
        mastery: String,
        next_review_at: Option<i64>,
        /// Absolute review count after the writer's increment. Carrying it
        /// as an absolute value (not a delta) keeps replay idempotent — a
        /// snapshot rebuild that re-applies the same event lands on the
        /// same number instead of double-counting.
        review_count: i64,
    },
    #[serde(rename = "vocab.delete")]
    VocabDelete { id: String },

    #[serde(rename = "translation.add")]
    TranslationAdd(TranslationPayload),
    #[serde(rename = "translation.delete")]
    TranslationDelete { id: String },

    #[serde(rename = "collection.create")]
    CollectionCreate {
        id: String,
        name: String,
        sort_order: i32,
    },
    #[serde(rename = "collection.rename")]
    CollectionRename { id: String, name: String },
    #[serde(rename = "collection.reorder")]
    CollectionReorder { id: String, sort_order: i32 },
    #[serde(rename = "collection.delete")]
    CollectionDelete { id: String },
    #[serde(rename = "collection.book.add")]
    CollectionBookAdd { collection: String, book: String },
    #[serde(rename = "collection.book.remove")]
    CollectionBookRemove { collection: String, book: String },

    #[serde(rename = "chat.create")]
    ChatCreate {
        id: String,
        book: String,
        title: String,
        model: Option<String>,
    },
    #[serde(rename = "chat.rename")]
    ChatRename { id: String, title: String },
    #[serde(rename = "chat.delete")]
    ChatDelete { id: String },
    #[serde(rename = "chat.message.add")]
    ChatMessageAdd(ChatMessagePayload),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BookImportPayload {
    pub id: String,
    pub title: String,
    pub author: String,
    pub description: Option<String>,
    pub cover_path: Option<String>,
    pub file_path: String,
    pub format: String,
    pub genre: Option<String>,
    pub pages: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HighlightPayload {
    pub id: String,
    pub book_id: String,
    pub cfi_range: String,
    pub color: String,
    pub note: Option<String>,
    pub text_content: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BookmarkPayload {
    pub id: String,
    pub book_id: String,
    pub cfi: String,
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct VocabPayload {
    pub id: String,
    pub book_id: String,
    pub word: String,
    pub definition: String,
    pub context_sentence: Option<String>,
    pub cfi: Option<String>,
    pub mastery: String,
    pub review_count: i64,
    pub next_review_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TranslationPayload {
    pub id: String,
    pub book_id: String,
    pub source_text: String,
    pub translated_text: String,
    pub target_language: String,
    pub cfi: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChatMessagePayload {
    pub id: String,
    pub chat_id: String,
    pub role: String,
    pub content: String,
    pub context: Option<String>,
    pub metadata: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn mk(body: EventBody) -> Event {
        Event {
            id: "01HYZX0000000000000000EVT1".to_string(),
            ts: 1_714_770_000_000,
            device: "11111111-2222-3333-4444-555555555555".to_string(),
            v: EVENT_SCHEMA_VERSION,
            body,
            extra: Map::new(),
        }
    }

    fn roundtrip(ev: &Event) {
        let json = serde_json::to_string(ev).unwrap();
        let back: Event = serde_json::from_str(&json).unwrap();
        assert_eq!(ev, &back, "roundtrip mismatch; wire form was: {json}");
    }

    #[test]
    fn roundtrip_book_events() {
        roundtrip(&mk(EventBody::BookImport(BookImportPayload {
            id: "b1".into(),
            title: "War and Peace".into(),
            author: "Tolstoy".into(),
            description: Some("long".into()),
            cover_path: Some("covers/b1.png".into()),
            file_path: "books/b1.epub".into(),
            format: "epub".into(),
            genre: None,
            pages: Some(1225),
        })));
        roundtrip(&mk(EventBody::BookDelete { id: "b1".into() }));
        roundtrip(&mk(EventBody::BookProgressSet {
            book: "b1".into(),
            progress: 42,
            cfi: Some("epubcfi(/6/4!/2[c01])".into()),
        }));
        roundtrip(&mk(EventBody::BookStatusSet {
            book: "b1".into(),
            status: "finished".into(),
        }));
        roundtrip(&mk(EventBody::BookMetadataSet {
            book: "b1".into(),
            field: "author".into(),
            value: json!("Leo Tolstoy"),
        }));
    }

    #[test]
    fn roundtrip_highlight_events() {
        roundtrip(&mk(EventBody::HighlightAdd(HighlightPayload {
            id: "h1".into(),
            book_id: "b1".into(),
            cfi_range: "epubcfi(/6/4!/2,/1:10,/1:20)".into(),
            color: "yellow".into(),
            note: Some("important".into()),
            text_content: Some("All happy families".into()),
        })));
        roundtrip(&mk(EventBody::HighlightDelete { id: "h1".into() }));
        roundtrip(&mk(EventBody::HighlightColorSet {
            id: "h1".into(),
            color: "pink".into(),
        }));
        roundtrip(&mk(EventBody::HighlightNoteSet {
            id: "h1".into(),
            note: None,
        }));
    }

    #[test]
    fn roundtrip_bookmark_events() {
        roundtrip(&mk(EventBody::BookmarkAdd(BookmarkPayload {
            id: "bm1".into(),
            book_id: "b1".into(),
            cfi: "epubcfi(/6/4!)".into(),
            label: Some("Chapter 1".into()),
        })));
        roundtrip(&mk(EventBody::BookmarkDelete { id: "bm1".into() }));
    }

    #[test]
    fn roundtrip_vocab_events() {
        roundtrip(&mk(EventBody::VocabAdd(VocabPayload {
            id: "v1".into(),
            book_id: "b1".into(),
            word: "serendipity".into(),
            definition: "a fortunate accident".into(),
            context_sentence: Some("What serendipity!".into()),
            cfi: None,
            mastery: "new".into(),
            review_count: 0,
            next_review_at: Some(1_714_856_400_000),
        })));
        roundtrip(&mk(EventBody::VocabMasterySet {
            id: "v1".into(),
            mastery: "learning".into(),
            next_review_at: Some(1_714_942_800_000),
            review_count: 3,
        }));
        roundtrip(&mk(EventBody::VocabDelete { id: "v1".into() }));
    }

    #[test]
    fn roundtrip_translation_events() {
        roundtrip(&mk(EventBody::TranslationAdd(TranslationPayload {
            id: "t1".into(),
            book_id: "b1".into(),
            source_text: "hello".into(),
            translated_text: "你好".into(),
            target_language: "zh".into(),
            cfi: None,
        })));
        roundtrip(&mk(EventBody::TranslationDelete { id: "t1".into() }));
    }

    #[test]
    fn roundtrip_collection_events() {
        roundtrip(&mk(EventBody::CollectionCreate {
            id: "c1".into(),
            name: "Favorites".into(),
            sort_order: 0,
        }));
        roundtrip(&mk(EventBody::CollectionRename {
            id: "c1".into(),
            name: "Top Reads".into(),
        }));
        roundtrip(&mk(EventBody::CollectionReorder {
            id: "c1".into(),
            sort_order: 3,
        }));
        roundtrip(&mk(EventBody::CollectionDelete { id: "c1".into() }));
        roundtrip(&mk(EventBody::CollectionBookAdd {
            collection: "c1".into(),
            book: "b1".into(),
        }));
        roundtrip(&mk(EventBody::CollectionBookRemove {
            collection: "c1".into(),
            book: "b1".into(),
        }));
    }

    #[test]
    fn roundtrip_chat_events() {
        roundtrip(&mk(EventBody::ChatCreate {
            id: "ch1".into(),
            book: "b1".into(),
            title: "New chat".into(),
            model: Some("claude-opus-4-6".into()),
        }));
        roundtrip(&mk(EventBody::ChatRename {
            id: "ch1".into(),
            title: "About Tolstoy".into(),
        }));
        roundtrip(&mk(EventBody::ChatDelete { id: "ch1".into() }));
        roundtrip(&mk(EventBody::ChatMessageAdd(ChatMessagePayload {
            id: "m1".into(),
            chat_id: "ch1".into(),
            role: "user".into(),
            content: "hi".into(),
            context: None,
            metadata: None,
        })));
    }

    #[test]
    fn wire_format_matches_spec() {
        // Frozen wire format — if someone changes this, iOS parsers break.
        let ev = mk(EventBody::BookDelete { id: "b1".into() });
        let v: Value = serde_json::from_str(&serde_json::to_string(&ev).unwrap()).unwrap();
        assert_eq!(v["type"], "book.delete");
        assert_eq!(v["payload"]["id"], "b1");
        assert_eq!(v["v"], 1);
        assert_eq!(v["ts"], 1_714_770_000_000_i64);
    }

    #[test]
    fn unknown_top_level_fields_preserved() {
        // Forward-compat: a future client writes an extra top-level field.
        // We read it, hold it in `extra`, and write it back verbatim.
        let src = json!({
            "id": "01HYZX0000000000000000EVT1",
            "ts": 1_714_770_000_000_i64,
            "device": "dev-a",
            "v": 2,
            "type": "book.delete",
            "payload": { "id": "b1" },
            "future_flag": "keep-me",
            "future_obj": { "nested": true }
        });
        let ev: Event = serde_json::from_value(src.clone()).unwrap();
        assert!(matches!(ev.body, EventBody::BookDelete { .. }));
        assert_eq!(ev.extra.get("future_flag"), Some(&json!("keep-me")));
        assert_eq!(ev.extra.get("future_obj"), Some(&json!({ "nested": true })));
        let reserialized: Value = serde_json::to_value(&ev).unwrap();
        assert_eq!(reserialized["future_flag"], "keep-me");
        assert_eq!(reserialized["future_obj"]["nested"], true);
    }

    #[test]
    fn empty_extra_is_omitted_from_wire() {
        let ev = mk(EventBody::BookDelete { id: "b1".into() });
        let json = serde_json::to_string(&ev).unwrap();
        // No stray fields past the tagged body + envelope.
        let v: Value = serde_json::from_str(&json).unwrap();
        let keys: Vec<&String> = v.as_object().unwrap().keys().collect();
        let expected: std::collections::HashSet<&str> =
            ["id", "ts", "device", "v", "type", "payload"].into_iter().collect();
        for k in keys {
            assert!(expected.contains(k.as_str()), "unexpected key in wire form: {k}");
        }
    }
}
