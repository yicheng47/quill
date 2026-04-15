//! Append-only JSONL log per device.
//!
//! Lives at `<shared>/logs/<device-uuid>.jsonl`. One line per event.
//!
//! A single `Mutex<Inner>` covers both the `ulid::Generator` and the file
//! append. This is load-bearing: without it two concurrent appends can
//! generate IDs `id_A < id_B` but reach the file in the other order
//! (`id_B\nid_A\n`), which permanently hides `id_A` from
//! `read_after(last_id=id_B)`. Holding the lock across generation AND the
//! write keeps the on-disk order strictly monotonic with the ID order.
//!
//! `NSFileCoordinator` wrapping is opt-in via `use_coordinator`. It's only
//! meaningful when the file lives inside an iCloud ubiquity container —
//! elsewhere the coordinator has no presenters to notify, so it's just
//! overhead and (on some machines) a source of spurious
//! `NSFileWriteUnknownError`. Callers pass `true` only when sync is enabled
//! and writing to the iCloud path.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use serde_json::Map;

use crate::error::{AppError, AppResult};

use super::events::{Event, EventBody, EVENT_SCHEMA_VERSION};

pub struct EventLog {
    path: PathBuf,
    device: String,
    use_coordinator: bool,
    inner: Mutex<Inner>,
}

struct Inner {
    gen: ulid::Generator,
}

impl EventLog {
    /// Open (or create) the log at `path`. Creates parent dirs.
    ///
    /// `use_coordinator = true` wraps each append in `NSFileCoordinator` on
    /// macOS; pass `true` when writing to an iCloud ubiquity container and
    /// `false` for local-only paths (tests, future non-iCloud backends).
    /// The flag is silently ignored on non-macOS platforms.
    pub fn open(path: &Path, device: &str, use_coordinator: bool) -> AppResult<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        // Touch the file so subsequent reads don't fail before any write.
        let _ = OpenOptions::new().create(true).append(true).open(path)?;
        Ok(Self {
            path: path.to_path_buf(),
            device: device.to_string(),
            use_coordinator,
            inner: Mutex::new(Inner {
                gen: ulid::Generator::new(),
            }),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Append one event. `ts` is the caller-chosen logical timestamp
    /// (unix millis) — typically the SQL `updated_at` value so the event
    /// mirrors the row it describes.
    pub fn append(&self, body: EventBody, ts: i64) -> AppResult<Event> {
        let mut out = self.append_batch(vec![body], ts)?;
        Ok(out.pop().expect("append_batch returns one for one input"))
    }

    /// Append many events atomically (single file open + fsync).
    ///
    /// The `Inner` mutex is held for the entire method — both ULID
    /// generation and the file write happen under it. See the module
    /// docstring for why that's required.
    pub fn append_batch(&self, bodies: Vec<EventBody>, ts: i64) -> AppResult<Vec<Event>> {
        if bodies.is_empty() {
            return Ok(Vec::new());
        }

        let mut inner = self
            .inner
            .lock()
            .map_err(|e| AppError::Other(format!("EventLog inner lock poisoned: {e}")))?;

        // ULID timestamps come from wall clock to preserve generator
        // monotonicity across process restarts; `ts` on the event is the
        // caller-supplied value (usually a few milliseconds earlier).
        let now = SystemTime::now();
        let mut events = Vec::with_capacity(bodies.len());
        for body in bodies {
            let ulid = inner
                .gen
                .generate_from_datetime(now)
                .map_err(|e| AppError::Other(format!("ulid generate: {e:?}")))?;
            events.push(Event {
                id: ulid.to_string(),
                ts,
                device: self.device.clone(),
                v: EVENT_SCHEMA_VERSION,
                body,
                extra: Map::new(),
            });
        }

        let mut buf = Vec::with_capacity(events.len() * 256);
        for ev in &events {
            serde_json::to_writer(&mut buf, ev)
                .map_err(|e| AppError::Other(format!("event serialize: {e}")))?;
            buf.push(b'\n');
        }
        append_bytes(&self.path, &buf, self.use_coordinator)?;

        Ok(events)
    }

    /// Parse every event in the log. Malformed or truncated lines are
    /// skipped with a `eprintln!` warning so a partial tail (from a crash
    /// mid-write) doesn't poison the whole read.
    pub fn read_all(&self) -> AppResult<Vec<Event>> {
        let bytes = match fs::read(&self.path) {
            Ok(b) => b,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(AppError::Io(e)),
        };
        let mut out = Vec::new();
        for (idx, line) in bytes.split(|&b| b == b'\n').enumerate() {
            if line.is_empty() {
                continue;
            }
            match serde_json::from_slice::<Event>(line) {
                Ok(ev) => out.push(ev),
                Err(e) => {
                    eprintln!(
                        "sync: skipping malformed log line {} in {}: {e}",
                        idx + 1,
                        self.path.display()
                    );
                }
            }
        }
        Ok(out)
    }

    /// Stream events with `id > last_id`. Passing `None` returns every event.
    ///
    /// ULIDs are lexicographically sortable — their 48-bit timestamp prefix
    /// dominates, so string `>` is equivalent to "later than" for IDs from
    /// a single monotonic generator. Across peers we tiebreak in the replay
    /// engine by `(ts, device)`.
    pub fn read_after(&self, last_id: Option<&str>) -> AppResult<Vec<Event>> {
        let all = self.read_all()?;
        match last_id {
            None => Ok(all),
            Some(lid) => Ok(all.into_iter().filter(|e| e.id.as_str() > lid).collect()),
        }
    }
}

fn append_bytes(path: &Path, bytes: &[u8], use_coordinator: bool) -> AppResult<()> {
    #[cfg(target_os = "macos")]
    {
        if use_coordinator {
            return coordinated_append(path, bytes).map_err(AppError::Io);
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = use_coordinator; // silence unused on non-macOS
    naive_append(path, bytes).map_err(AppError::Io)
}

fn naive_append(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut f = OpenOptions::new().create(true).append(true).open(path)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    Ok(())
}

// -------------------------------------------------------------------------
// macOS: NSFileCoordinator-wrapped append.
//
// Apple's iCloud daemon (`bird`) is a silent second writer on every file in
// the ubiquity container — it uploads, re-downloads, evicts, and rematerializes
// without notifying us. A naive POSIX append races with it: the daemon can
// upload a partial write, or we can append over a stub that was evicted.
// NSFileCoordinator's writing accessor tells presenters (including the
// daemon) to pause, waits for in-flight downloads/uploads, materializes
// placeholders, and hands us a URL to write through.
//
// Only meaningful on paths inside a ubiquity container. Callers gate via
// `use_coordinator`.
// -------------------------------------------------------------------------
#[cfg(target_os = "macos")]
fn coordinated_append(path: &Path, bytes: &[u8]) -> io::Result<()> {
    use block2::StackBlock;
    use objc2_foundation::{
        NSFileCoordinator, NSFileCoordinatorWritingOptions, NSString, NSURL,
    };
    use std::cell::RefCell;
    use std::ptr::NonNull;

    let path_str = path.to_string_lossy();
    let ns_path = NSString::from_str(&path_str);
    let url = NSURL::fileURLWithPath(&ns_path);
    let coord = NSFileCoordinator::new();

    // The accessor runs synchronously on the calling thread before
    // coordinateWriting… returns, so a RefCell is sufficient (no cross-thread
    // sharing, no locking overhead).
    let inner_result: RefCell<io::Result<()>> = RefCell::new(Ok(()));

    let writer_block = StackBlock::new(|coordinated_url: NonNull<NSURL>| {
        let url_ref: &NSURL = unsafe { coordinated_url.as_ref() };
        let p_ns = url_ref.path();
        let target = match p_ns {
            Some(s) => PathBuf::from(s.to_string()),
            None => {
                *inner_result.borrow_mut() = Err(io::Error::other(
                    "NSFileCoordinator: coordinated URL has no .path",
                ));
                return;
            }
        };
        *inner_result.borrow_mut() = naive_append(&target, bytes);
    });

    let mut nserror: Option<objc2::rc::Retained<objc2_foundation::NSError>> = None;
    coord.coordinateWritingItemAtURL_options_error_byAccessor(
        &url,
        NSFileCoordinatorWritingOptions::empty(),
        Some(&mut nserror),
        &writer_block,
    );

    if let Some(err) = nserror {
        return Err(io::Error::other(format!(
            "NSFileCoordinator writing error: {err:?}"
        )));
    }
    inner_result.into_inner()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::events::BookImportPayload;
    use std::sync::Arc;
    use tempfile::TempDir;

    fn sample_body(n: usize) -> EventBody {
        EventBody::BookImport(BookImportPayload {
            id: format!("b{n}"),
            title: format!("Book {n}"),
            author: "Someone".into(),
            description: None,
            cover_path: None,
            file_path: format!("books/b{n}.epub"),
            format: "epub".into(),
            genre: None,
            pages: None,
        })
    }

    /// Tests run against TempDir — no ubiquity container, no file presenters,
    /// nothing for NSFileCoordinator to coordinate with. We always pass
    /// `use_coordinator = false` so tests are hermetic and fast.
    fn open_log(tmp: &TempDir) -> EventLog {
        let p = tmp.path().join("logs").join("dev-A.jsonl");
        EventLog::open(&p, "dev-A", false).unwrap()
    }

    #[test]
    fn open_creates_parent_dirs() {
        let tmp = TempDir::new().unwrap();
        let log = open_log(&tmp);
        assert!(log.path().exists());
        assert!(log.path().parent().unwrap().exists());
    }

    #[test]
    fn append_then_read_all_one_event() {
        let tmp = TempDir::new().unwrap();
        let log = open_log(&tmp);
        let ev = log.append(sample_body(1), 1_714_770_000_000).unwrap();
        let events = log.read_all().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0], ev);
    }

    #[test]
    fn append_preserves_order_and_monotonic_ids() {
        let tmp = TempDir::new().unwrap();
        let log = open_log(&tmp);
        for i in 0..10 {
            log.append(sample_body(i), 1_714_770_000_000 + i as i64)
                .unwrap();
        }
        let events = log.read_all().unwrap();
        assert_eq!(events.len(), 10);
        for w in events.windows(2) {
            assert!(w[0].id < w[1].id, "ids not strictly increasing");
        }
    }

    #[test]
    fn append_batch_shares_ts_and_generates_distinct_ids() {
        let tmp = TempDir::new().unwrap();
        let log = open_log(&tmp);
        let bodies = vec![sample_body(1), sample_body(2), sample_body(3)];
        let ts = 1_714_770_000_000;
        let evs = log.append_batch(bodies, ts).unwrap();
        assert_eq!(evs.len(), 3);
        for e in &evs {
            assert_eq!(e.ts, ts);
        }
        let ids: std::collections::HashSet<&str> =
            evs.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids.len(), 3, "ulid collision in batch");
        let read = log.read_all().unwrap();
        assert_eq!(read, evs);
    }

    #[test]
    fn read_after_filters_by_last_id() {
        let tmp = TempDir::new().unwrap();
        let log = open_log(&tmp);
        let mut ids = Vec::new();
        for i in 0..5 {
            ids.push(
                log.append(sample_body(i), 1_714_770_000_000 + i as i64)
                    .unwrap()
                    .id,
            );
        }
        let tail = log.read_after(Some(&ids[2])).unwrap();
        assert_eq!(tail.len(), 2);
        assert_eq!(tail[0].id, ids[3]);
        assert_eq!(tail[1].id, ids[4]);

        let all = log.read_after(None).unwrap();
        assert_eq!(all.len(), 5);
    }

    #[test]
    fn read_all_on_missing_file_returns_empty() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("nope.jsonl");
        let log = EventLog::open(&p, "dev-A", false).unwrap();
        std::fs::remove_file(&p).unwrap();
        let events = log.read_all().unwrap();
        assert_eq!(events.len(), 0);
    }

    #[test]
    fn torn_write_tail_is_skipped() {
        let tmp = TempDir::new().unwrap();
        let log = open_log(&tmp);
        log.append(sample_body(1), 1_714_770_000_000).unwrap();
        log.append(sample_body(2), 1_714_770_000_001).unwrap();
        log.append(sample_body(3), 1_714_770_000_002).unwrap();

        let mut bytes = std::fs::read(log.path()).unwrap();
        let last_nl = bytes[..bytes.len() - 1]
            .iter()
            .rposition(|&b| b == b'\n')
            .unwrap();
        bytes.truncate(last_nl + 20);
        std::fs::write(log.path(), &bytes).unwrap();

        let events = log.read_all().unwrap();
        assert_eq!(events.len(), 2, "truncated last line should be skipped");
    }

    #[test]
    fn read_preserves_unknown_top_level_fields() {
        let tmp = TempDir::new().unwrap();
        let log = open_log(&tmp);
        let raw = r#"{"id":"01HYZX0000000000000000EVTZ","ts":1714770000000,"device":"dev-A","v":2,"type":"bookmark.add","payload":{"id":"bm1","book_id":"b1","cfi":"epubcfi(/6/4!)","label":null},"future_field":"keep-me"}"#;
        let mut bytes = Vec::new();
        bytes.extend_from_slice(raw.as_bytes());
        bytes.push(b'\n');
        std::fs::write(log.path(), &bytes).unwrap();

        let events = log.read_all().unwrap();
        assert_eq!(events.len(), 1);
        assert!(matches!(events[0].body, EventBody::BookmarkAdd(_)));
        assert_eq!(
            events[0].extra.get("future_field"),
            Some(&serde_json::json!("keep-me"))
        );
    }

    #[test]
    fn ids_increase_across_processes_via_wall_clock_prefix() {
        let tmp = TempDir::new().unwrap();
        let p = tmp.path().join("dev-A.jsonl");
        let log_a = EventLog::open(&p, "dev-A", false).unwrap();
        let id_a = log_a
            .append(sample_body(1), 1_714_770_000_000)
            .unwrap()
            .id;
        std::thread::sleep(std::time::Duration::from_millis(2));
        drop(log_a);
        let log_b = EventLog::open(&p, "dev-A", false).unwrap();
        let id_b = log_b
            .append(sample_body(2), 1_714_770_000_002)
            .unwrap()
            .id;
        assert!(
            id_b > id_a,
            "post-restart id {id_b} should sort after pre-restart id {id_a}"
        );
    }

    #[test]
    fn concurrent_appends_preserve_id_file_order() {
        // Regression test for finding #1: previously the mutex only covered
        // ULID generation, not the file write. That let two threads generate
        // id_A < id_B but write in the reverse order, permanently hiding
        // id_A from read_after(id_B). This test stresses that race and
        // verifies file order matches id order.
        let tmp = TempDir::new().unwrap();
        let log = Arc::new(open_log(&tmp));

        let mut handles = Vec::new();
        for t in 0..8 {
            let log = Arc::clone(&log);
            handles.push(std::thread::spawn(move || {
                let mut ids = Vec::new();
                for i in 0..50 {
                    let ev = log
                        .append(sample_body(t * 100 + i), 1_714_770_000_000 + i as i64)
                        .unwrap();
                    ids.push(ev.id);
                }
                ids
            }));
        }
        let _: Vec<Vec<String>> = handles.into_iter().map(|h| h.join().unwrap()).collect();

        // Read the file back; verify ids are strictly increasing in file order.
        let events = log.read_all().unwrap();
        assert_eq!(events.len(), 8 * 50);
        for w in events.windows(2) {
            assert!(
                w[0].id < w[1].id,
                "file order broke: {} then {}",
                w[0].id,
                w[1].id
            );
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "manual smoke test against the real iCloud ubiquity container"]
    fn coordinated_append_smoke_on_real_icloud_path() {
        let shared_dir = crate::icloud::icloud_data_dir_fast()
            .or_else(crate::icloud::icloud_data_dir)
            .expect("expected a local iCloud Documents container");
        let logs_dir = shared_dir.join("logs");
        std::fs::create_dir_all(&logs_dir).unwrap();

        let file = logs_dir.join(format!(
            "_codex-sync-smoke-{}.jsonl",
            uuid::Uuid::new_v4()
        ));
        let log = EventLog::open(&file, "dev-smoke", true).unwrap();

        let ev = log.append(sample_body(1), 1_714_770_000_000).unwrap();
        let events = log.read_all().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0], ev);

        std::fs::remove_file(file).unwrap();
    }
}
