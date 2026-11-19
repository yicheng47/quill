//! Tests against a scripted app server that answers with responses and
//! notifications recorded from a real `codex app-server` 0.170.0.

use super::*;
use std::path::Path;
use tokio::io::AsyncWriteExt;

const RECORDED_THREAD: &str = "id-125cd6";
const RECORDED_TURN: &str = "id-c404f7";

fn fixture(name: &str) -> Value {
    let text = match name {
        "initialize" => include_str!("fixtures/initialize.json"),
        "account_read" => include_str!("fixtures/account_read.json"),
        "model_list" => include_str!("fixtures/model_list.json"),
        "config_read" => include_str!("fixtures/config_read.json"),
        "thread_start" => include_str!("fixtures/thread_start.json"),
        "turn_start" => include_str!("fixtures/turn_start.json"),
        _ => panic!("unknown fixture {name}"),
    };
    serde_json::from_str(text).unwrap()
}

fn recorded_turn(thread_id: &str, turn_id: &str) -> Vec<Value> {
    include_str!("fixtures/turn_notifications.jsonl")
        .lines()
        .map(|line| {
            serde_json::from_str(&line.replace(RECORDED_THREAD, thread_id).replace(RECORDED_TURN, turn_id))
                .unwrap()
        })
        .collect()
}

const RECORDED_REPLY: &str = "Clever humor expressed with sharp brevity.";

#[derive(Default)]
struct Recorder {
    events: Mutex<Vec<(String, Value)>>,
    urls: Mutex<Vec<String>>,
}

impl ShellHost for Recorder {
    fn emit(&self, event: &str, payload: Value) {
        self.events.lock().unwrap().push((event.to_string(), payload));
    }
    fn emit_to(&self, _w: &str, _e: &str, _p: Value) {}
    fn open_url(&self, url: &str) -> AppResult<()> {
        self.urls.lock().unwrap().push(url.to_string());
        Ok(())
    }
    fn reveal_path(&self, _p: &Path) -> AppResult<()> {
        Ok(())
    }
}

impl Recorder {
    fn text(&self, event: &str) -> String {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter(|(e, _)| e == event)
            .filter_map(|(_, p)| p["delta"].as_str().map(str::to_string))
            .collect()
    }

    fn done(&self, event: &str) -> bool {
        self.events.lock().unwrap().iter().any(|(e, p)| e == event && p["done"] == true)
    }

    async fn wait_done(&self, event: &str) {
        for _ in 0..200 {
            if self.done(event) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("no done chunk on {event}: {:?}", self.events.lock().unwrap());
    }
}

/// How the scripted server answers; `None` falls back to the recordings.
type Script = dyn Fn(&str, &Value, &FakeState) -> Option<Reply> + Send + Sync;

enum Reply {
    Result(Value),
    Error(&'static str),
    /// Respond, then send these notifications.
    Then(Value, Vec<Value>),
    /// Wait for the test to release a reply before answering this request.
    Deferred(tokio::sync::oneshot::Receiver<Reply>),
}

#[derive(Default)]
struct FakeState {
    requests: Mutex<Vec<(u64, String, Value)>>,
    launches: AtomicU64,
    threads: AtomicU64,
    kill: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    outbox: Mutex<Option<mpsc::UnboundedSender<Value>>>,
}

impl FakeState {
    fn requests(&self, method: &str) -> Vec<Value> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, m, _)| m == method)
            .map(|(_, _, p)| p.clone())
            .collect()
    }

    fn kill(&self) {
        if let Some(tx) = self.kill.lock().unwrap().take() {
            let _ = tx.send(());
        }
    }

    fn send(&self, message: Value) {
        if let Some(tx) = self.outbox.lock().unwrap().as_ref() {
            let _ = tx.send(message);
        }
    }
}

fn default_reply(method: &str, params: &Value, state: &FakeState) -> Reply {
    match method {
        "initialize" => Reply::Result(fixture("initialize")),
        "account/read" => Reply::Result(fixture("account_read")),
        "model/list" => Reply::Result(fixture("model_list")),
        "config/read" => Reply::Result(fixture("config_read")),
        "thread/start" => {
            let n = state.threads.fetch_add(1, Ordering::SeqCst) + 1;
            let mut result = fixture("thread_start");
            result["thread"]["id"] = json!(format!("thread-{n}"));
            Reply::Result(result)
        }
        "turn/start" => {
            let thread_id = params["threadId"].as_str().unwrap().to_string();
            let turn_id = format!("turn-{}", state.requests("turn/start").len());
            let mut result = fixture("turn_start");
            result["turn"]["id"] = json!(turn_id);
            Reply::Then(result, recorded_turn(&thread_id, &turn_id))
        }
        _ => Reply::Result(json!({})),
    }
}

fn fake_launcher(state: Arc<FakeState>, script: Arc<Script>) -> Launcher {
    Arc::new(move |_override, _cwd| {
        let state = Arc::clone(&state);
        let script = Arc::clone(&script);
        Box::pin(async move {
            state.launches.fetch_add(1, Ordering::SeqCst);
            let (client_side, server_side) = tokio::io::duplex(1 << 20);
            let (client_read, client_write) = tokio::io::split(client_side);
            let (server_read, mut server_write) = tokio::io::split(server_side);
            let (kill_tx, mut kill_rx) = tokio::sync::oneshot::channel::<()>();
            let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Value>();
            *state.kill.lock().unwrap() = Some(kill_tx);
            *state.outbox.lock().unwrap() = Some(out_tx.clone());
            let server_state = Arc::clone(&state);
            tokio::spawn(async move {
                let mut lines = BufReader::new(server_read).lines();
                loop {
                    tokio::select! {
                        _ = &mut kill_rx => break,
                        Some(message) = out_rx.recv() => {
                            let _ = server_write.write_all(format!("{message}\n").as_bytes()).await;
                        }
                        line = lines.next_line() => {
                            let Ok(Some(line)) = line else { break };
                            let message: Value = serde_json::from_str(&line).unwrap();
                            let (Some(id), Some(method)) = (message["id"].as_u64(), message["method"].as_str()) else {
                                continue;
                            };
                            let params = message["params"].clone();
                            server_state.requests.lock().unwrap().push((id, method.to_string(), params.clone()));
                            let reply = script(method, &params, &server_state)
                                .unwrap_or_else(|| default_reply(method, &params, &server_state));
                            let send_reply = |out_tx: &mpsc::UnboundedSender<Value>, id: u64, reply: Reply| {
                                let (response, then) = match reply {
                                    Reply::Result(r) => (Some(json!({"id": id, "result": r})), vec![]),
                                    Reply::Error(msg) => (Some(json!({"id": id, "error": {"code": -32600, "message": msg}})), vec![]),
                                    Reply::Then(r, notes) => (Some(json!({"id": id, "result": r})), notes),
                                    Reply::Deferred(_) => unreachable!("nested deferred reply"),
                                };
                                for message in response.into_iter().chain(then) {
                                    let _ = out_tx.send(message);
                                }
                            };
                            match reply {
                                Reply::Deferred(rx) => {
                                    let out_tx = out_tx.clone();
                                    tokio::spawn(async move {
                                        if let Ok(resolved) = rx.await {
                                            send_reply(&out_tx, id, resolved);
                                        }
                                    });
                                }
                                immediate => send_reply(&out_tx, id, immediate),
                            }
                        }
                    }
                }
            });
            Ok(Launched {
                reader: Box::new(client_read),
                writer: Box::new(client_write),
                child: None,
                found: Found { path: PathBuf::from("/usr/local/bin/codex"), from_override: false },
                version: Version(0, 170, 0),
                stderr_tail: Arc::new(Mutex::new(String::new())),
            })
        })
    })
}

fn codex_with(script: impl Fn(&str, &Value, &FakeState) -> Option<Reply> + Send + Sync + 'static) -> (Arc<Codex>, Arc<FakeState>) {
    let state = Arc::new(FakeState::default());
    let cwd = std::env::temp_dir().join(format!("quill-codex-test-{}", ulid::Ulid::new()));
    let codex = Arc::new(Codex::with_launcher(cwd, fake_launcher(Arc::clone(&state), Arc::new(script))));
    (codex, state)
}

fn codex() -> (Arc<Codex>, Arc<FakeState>) {
    codex_with(|_, _, _| None)
}

fn msg(role: &str, content: &str) -> ChatMessage {
    ChatMessage { role: role.to_string(), content: content.to_string() }
}

fn spec(event: &str, messages: Vec<ChatMessage>, chat_id: Option<&str>) -> TurnSpec {
    TurnSpec {
        system: "You are a reading assistant.".to_string(),
        messages,
        chat_id: chat_id.map(str::to_string),
        model_setting: Some("gpt-6-luna".to_string()),
        effort_setting: Some("low".to_string()),
        event_name: event.to_string(),
    }
}

async fn run(codex: &Arc<Codex>, host: &Arc<Recorder>, spec: TurnSpec) {
    let event = spec.event_name.clone();
    codex.start_turn(host.clone(), None, spec).await.expect("start_turn");
    host.wait_done(&event).await;
}

#[test]
fn parses_recorded_account_and_models() {
    let account = parse_account(&fixture("account_read"));
    assert_eq!(
        account,
        Account { signed_in: true, email: Some("reader@example.com".into()), plan: Some("pro".into()) }
    );
    let signed_out = parse_account(&json!({"account": null, "requiresOpenaiAuth": true}));
    assert!(!signed_out.signed_in);
    let custom_provider_null = parse_account(&json!({"account": null, "requiresOpenaiAuth": false}));
    assert!(!custom_provider_null.signed_in, "null account must not be treated as ready even when requiresOpenaiAuth is false");
    let non_openai = parse_account(&json!({"account": {"type": "amazonBedrock"}, "requiresOpenaiAuth": false}));
    assert!(!non_openai.signed_in);

    let models = parse_models(&fixture("model_list"));
    assert_eq!(
        models.iter().map(|m| m.slug.as_str()).collect::<Vec<_>>(),
        ["gpt-6.2-sol", "gpt-6-luna", "gpt-5.6-sol"],
        "hidden models are filtered"
    );
    assert!(models[0].is_default);
    assert_eq!(models[1].display_name, "GPT-6-Luna");
    assert_eq!(models[1].default_reasoning_level, "medium");
    assert_eq!(models[1].supported_reasoning_levels, ["low", "medium", "high", "xhigh", "max"]);
}

#[test]
fn isolation_overrides_cover_every_listed_server_plugin_and_builtin_tool() {
    let overrides = isolation_overrides(&fixture("config_read"));
    let obj = overrides.as_object().expect("overrides object");
    assert_eq!(obj.get("mcp_servers.quill.enabled"), Some(&json!(false)));
    assert_eq!(obj.get("mcp_servers.pencil.enabled"), Some(&json!(false)));
    assert_eq!(obj.get("plugins.chrome@openai-bundled.enabled"), Some(&json!(false)));
    assert_eq!(obj.get("plugins.documents@openai-primary-runtime.enabled"), Some(&json!(false)));
    assert_eq!(obj.get("features.shell_tool"), Some(&json!(false)));
    assert_eq!(obj.get("features.unified_exec"), Some(&json!(false)));
    assert_eq!(obj.get("features.multi_agent"), Some(&json!(false)));
    assert_eq!(obj.get("features.multi_agent_v2"), Some(&json!(false)));
    assert_eq!(obj.get("features.apps"), Some(&json!(false)));
    assert_eq!(obj.get("features.plugins"), Some(&json!(false)));
    assert_eq!(obj.get("features.hooks"), Some(&json!(false)));
    assert_eq!(obj.get("features.browser_use"), Some(&json!(false)));
    assert_eq!(obj.get("features.computer_use"), Some(&json!(false)));
    assert_eq!(obj.get("web_search"), Some(&json!("disabled")));

    let args = app_server_args();
    assert_eq!(args[0], "app-server");
    assert!(args.iter().any(|a| a == "model_provider=\"openai\""), "args={args:?}");
    assert!(args.iter().any(|a| a == "features.shell_tool=false"), "args={args:?}");
    assert!(args.iter().any(|a| a == "web_search=\"disabled\""), "args={args:?}");
}

#[test]
fn model_and_effort_are_always_explicit() {
    let models = parse_models(&fixture("model_list"));
    assert_eq!(resolve_model_and_effort(&models, Some("gpt-6-luna"), Some("high")), ("gpt-6-luna".into(), "high".into()));
    assert_eq!(resolve_model_and_effort(&models, Some("gpt-6-luna"), Some("default")), ("gpt-6-luna".into(), "medium".into()));
    assert_eq!(resolve_model_and_effort(&models, Some(""), None), ("gpt-6.2-sol".into(), "low".into()));
    assert_eq!(resolve_model_and_effort(&models, Some("my-custom"), None), ("my-custom".into(), "low".into()));
    assert_eq!(resolve_model_and_effort(&[], None, None), ("".into(), "low".into()));
}

#[tokio::test]
async fn one_shot_turn_streams_recorded_deltas_with_isolation() {
    let (codex, state) = codex();
    let host = Arc::new(Recorder::default());
    run(&codex, &host, spec("ai-lookup-chunk-1", vec![msg("user", "Define 'wit'")], None)).await;

    assert_eq!(host.text("ai-lookup-chunk-1"), RECORDED_REPLY);
    let threads = state.requests("thread/start");
    assert_eq!(threads.len(), 1);
    let thread = &threads[0];
    assert_eq!(thread["cwd"], json!(codex.cwd));
    assert!(codex.cwd.is_dir(), "the Quill-owned cwd exists");
    assert_eq!(std::fs::read_dir(&codex.cwd).unwrap().count(), 0, "and is empty");
    assert_eq!(thread["ephemeral"], true);
    assert_eq!(thread["sandbox"], "read-only");
    assert_eq!(thread["approvalPolicy"], "never");
    assert_eq!(thread["modelProvider"], "openai");
    assert!(thread["baseInstructions"].as_str().unwrap().starts_with("You are a reading assistant."));
    assert_eq!(thread["config"], isolation_overrides(&fixture("config_read")));
    assert_eq!(thread["config"]["features.shell_tool"], false);
    assert_eq!(thread["config"]["features.unified_exec"], false);
    assert_eq!(thread["config"]["mcp_servers.quill.enabled"], false);
    assert_eq!(state.requests("model/list")[0]["modelProvider"], "openai");

    let turn = &state.requests("turn/start")[0];
    assert_eq!(turn["model"], "gpt-6-luna");
    assert_eq!(turn["effort"], "low");
    assert_eq!(turn["input"], json!([{"type": "text", "text": "Define 'wit'"}]));

    tokio::time::sleep(Duration::from_millis(30)).await;
    assert_eq!(state.requests("thread/unsubscribe"), vec![json!({"threadId": "thread-1"})]);
    let init = &state.requests("initialize")[0];
    assert_eq!(init["clientInfo"]["name"], "quill");
}

#[tokio::test]
async fn every_turn_sends_model_and_effort_even_when_unset() {
    let (codex, state) = codex();
    let host = Arc::new(Recorder::default());
    let mut s = spec("e", vec![msg("user", "hi")], None);
    s.model_setting = None;
    s.effort_setting = Some("default".into());
    run(&codex, &host, s).await;
    let turn = &state.requests("turn/start")[0];
    assert_eq!(turn["model"], "gpt-6.2-sol");
    assert_eq!(turn["effort"], "low");
}

#[tokio::test]
async fn one_app_server_serves_concurrent_calls() {
    let (codex, state) = codex();
    let host = Arc::new(Recorder::default());
    let a = codex.start_turn(host.clone(), None, spec("a", vec![msg("user", "x")], None));
    let b = codex.start_turn(host.clone(), None, spec("b", vec![msg("user", "y")], None));
    let (a, b) = tokio::join!(a, b);
    a.unwrap();
    b.unwrap();
    host.wait_done("a").await;
    host.wait_done("b").await;
    assert_eq!(state.launches.load(Ordering::SeqCst), 1);
    assert_eq!(state.requests("initialize").len(), 1);
}

#[tokio::test]
async fn restarts_after_the_app_server_dies() {
    let (codex, state) = codex();
    let host = Arc::new(Recorder::default());
    run(&codex, &host, spec("one", vec![msg("user", "x")], None)).await;
    state.kill();
    tokio::time::sleep(Duration::from_millis(30)).await;
    run(&codex, &host, spec("two", vec![msg("user", "y")], None)).await;
    assert_eq!(state.launches.load(Ordering::SeqCst), 2);
    assert_eq!(host.text("two"), RECORDED_REPLY);
}

#[tokio::test]
async fn death_mid_turn_reports_an_error_on_the_channel() {
    let (codex, state) = codex_with(|method, params, state| {
        (method == "turn/start").then(|| {
            let thread = params["threadId"].as_str().unwrap();
            let mut notes = recorded_turn(thread, "turn-x");
            notes.truncate(7);
            let killer = state.kill.lock().unwrap().take();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(50)).await;
                if let Some(k) = killer {
                    let _ = k.send(());
                }
            });
            Reply::Then(json!({"turn": {"id": "turn-x"}}), notes)
        })
    });
    let host = Arc::new(Recorder::default());
    run(&codex, &host, spec("e", vec![msg("user", "x")], None)).await;
    let text = host.text("e");
    assert!(text.starts_with("Cl"), "partial reply streamed: {text}");
    assert!(text.contains("Error: AI error: Codex stopped unexpectedly"), "{text}");
    drop(state);
}

#[tokio::test]
async fn failed_turn_maps_error_and_unauthorized() {
    for (info, expected) in [("other", "Error: AI error: quota exhausted"), ("unauthorized", CODEX_NOT_SIGNED_IN)] {
        let (codex, _state) = codex_with(move |method, params, _| {
            (method == "turn/start").then(|| {
                let thread = params["threadId"].as_str().unwrap();
                Reply::Then(
                    json!({"turn": {"id": "t"}}),
                    vec![
                        json!({"method": "error", "params": {"threadId": thread, "turnId": "t", "willRetry": true, "error": {"message": "retrying"}}}),
                        json!({"method": "error", "params": {"threadId": thread, "turnId": "t", "willRetry": false, "error": {"message": "quota exhausted", "codexErrorInfo": info}}}),
                        json!({"method": "turn/completed", "params": {"threadId": thread, "turn": {"id": "t", "status": "failed", "items": [], "error": {"message": "quota exhausted"}}}}),
                    ],
                )
            })
        });
        let host = Arc::new(Recorder::default());
        run(&codex, &host, spec("e", vec![msg("user", "x")], None)).await;
        assert_eq!(host.text("e"), expected);
    }
}

#[tokio::test]
async fn commentary_and_tool_items_are_not_streamed() {
    let (codex, _state) = codex_with(|method, params, _| {
        (method == "turn/start").then(|| {
            let thread = params["threadId"].as_str().unwrap();
            let note = |method: &str, params: Value| json!({"method": method, "params": params});
            Reply::Then(
                json!({"turn": {"id": "t"}}),
                vec![
                    note("item/started", json!({"threadId": thread, "turnId": "t", "item": {"type": "agentMessage", "id": "c1", "phase": "commentary"}})),
                    note("item/agentMessage/delta", json!({"threadId": thread, "turnId": "t", "itemId": "c1", "delta": "thinking aloud "})),
                    note("item/started", json!({"threadId": thread, "turnId": "t", "item": {"type": "commandExecution", "id": "cmd1", "command": "ls"}})),
                    note("item/commandExecution/outputDelta", json!({"threadId": thread, "turnId": "t", "itemId": "cmd1", "delta": "secret-file.txt\n"})),
                    note("item/completed", json!({"threadId": thread, "turnId": "t", "item": {"type": "commandExecution", "id": "cmd1", "status": "completed"}})),
                    note("item/started", json!({"threadId": thread, "turnId": "t", "item": {"type": "mcpToolCall", "id": "mcp1", "server": "quill", "tool": "list_books"}})),
                    note("item/completed", json!({"threadId": thread, "turnId": "t", "item": {"type": "mcpToolCall", "id": "mcp1", "status": "completed"}})),
                    note("item/started", json!({"threadId": thread, "turnId": "t", "item": {"type": "agentMessage", "id": "m1", "phase": "final_answer"}})),
                    note("item/agentMessage/delta", json!({"threadId": thread, "turnId": "t", "itemId": "m1", "delta": "Answer"})),
                    note("turn/completed", json!({"threadId": thread, "turn": {"id": "t", "status": "completed", "items": []}})),
                ],
            )
        })
    });
    let host = Arc::new(Recorder::default());
    run(&codex, &host, spec("e", vec![msg("user", "x")], None)).await;
    assert_eq!(host.text("e"), "Answer");
}

#[tokio::test]
async fn interrupt_sends_turn_interrupt_and_finishes_quietly() {
    let (codex, _state) = codex_with(|method, params, state| match method {
        "turn/start" => {
            let thread = params["threadId"].as_str().unwrap().to_string();
            let notes = recorded_turn(&thread, "t");
            Some(Reply::Then(json!({"turn": {"id": "t"}}), notes[..7].to_vec()))
        }
        "turn/interrupt" => {
            let thread = params["threadId"].as_str().unwrap();
            state.send(json!({"method": "turn/completed", "params": {"threadId": thread, "turn": {"id": "t", "status": "interrupted", "items": []}}}));
            Some(Reply::Result(json!({})))
        }
        _ => None,
    });
    let host = Arc::new(Recorder::default());
    codex
        .start_turn(host.clone(), None, spec("chunk", vec![msg("user", "x")], Some("chat")))
        .await
        .unwrap();
    for _ in 0..100 {
        if !host.text("chunk").is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    tokio::time::sleep(Duration::from_millis(30)).await;
    codex.interrupt("chunk").await;
    host.wait_done("chunk").await;
    assert!(!host.text("chunk").contains("Error"), "{}", host.text("chunk"));
    assert!(codex.chat_thread("chat").is_none(), "an interrupted chat reseeds next time");
    assert_eq!(_state.requests("turn/interrupt"), vec![json!({"threadId": "thread-1", "turnId": "t"})]);
}

#[tokio::test]
async fn not_signed_in_is_a_sentinel_before_any_thread() {
    let (codex, state) = codex_with(|method, _, _| {
        (method == "account/read").then(|| Reply::Result(json!({"account": null, "requiresOpenaiAuth": true})))
    });
    let host = Arc::new(Recorder::default());
    let err = codex.start_turn(host.clone(), None, spec("e", vec![msg("user", "x")], None)).await.unwrap_err();
    assert_eq!(err.to_string(), CODEX_NOT_SIGNED_IN);
    assert!(state.requests("thread/start").is_empty());
    assert_eq!(codex.status(None).await.state, "not_signed_in");
}

#[tokio::test]
async fn status_reports_ready_account_and_version() {
    let (codex, _state) = codex();
    let status = codex.status(None).await;
    assert_eq!(status.state, "ready");
    assert_eq!(status.email.as_deref(), Some("reader@example.com"));
    assert_eq!(status.plan.as_deref(), Some("pro"));
    assert_eq!(status.version.as_deref(), Some("0.170.0"));
    assert_eq!(status.path.as_deref(), Some("/usr/local/bin/codex"));
    assert_eq!(status.min_version, "0.170.0");
}

#[tokio::test]
async fn start_errors_map_to_status_and_sentinels() {
    for (err, state, sentinel) in [
        (StartError::NotInstalled, "not_installed", CODEX_NOT_INSTALLED),
        (StartError::TooOld { version: Version(0, 141, 2), path: "/x/codex".into() }, "too_old", CODEX_TOO_OLD),
        (
            StartError::Failed { message: "codex app-server exited: bad config".into(), version: None, path: None },
            "failed",
            CODEX_FAILED,
        ),
    ] {
        let launcher_err = err.clone();
        let launcher: Launcher = Arc::new(move |_, _| {
            let err = launcher_err.clone();
            Box::pin(async move { Err(err) })
        });
        let codex = Arc::new(Codex::with_launcher(std::env::temp_dir().join("quill-codex-err"), launcher));
        let status = codex.status(None).await;
        assert_eq!(status.state, state);
        if let StartError::TooOld { .. } = err {
            assert_eq!(status.version.as_deref(), Some("0.141.2"));
        }
        if let StartError::Failed { .. } = err {
            assert_eq!(status.error.as_deref(), Some("codex app-server exited: bad config"));
        }
        let host = Arc::new(Recorder::default());
        let e = codex.start_turn(host, None, spec("e", vec![msg("user", "x")], None)).await.unwrap_err();
        assert_eq!(e.to_string(), sentinel);
    }
}

#[tokio::test]
async fn handshake_failure_is_failed_to_start() {
    let (codex, _state) = codex_with(|method, _, _| (method == "initialize").then_some(Reply::Error("unsupported client")));
    let status = codex.status(None).await;
    assert_eq!(status.state, "failed");
    assert!(status.error.unwrap().contains("unsupported client"));
}

#[tokio::test]
async fn login_opens_the_auth_url_and_waits_for_completion() {
    let (codex, state) = codex_with(|method, _, state| {
        (method == "account/login/start").then(|| {
            let outbox = state.outbox.lock().unwrap().clone().unwrap();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(40)).await;
                let _ = outbox.send(json!({"method": "account/login/completed", "params": {"loginId": "L1", "success": true, "error": null}}));
            });
            Reply::Result(json!({"type": "chatgpt", "loginId": "L1", "authUrl": "https://auth.example/start"}))
        })
    });
    let host = Recorder::default();
    let outcome = codex.login(&host, None).await.unwrap();
    assert_eq!(outcome, LoginOutcome { success: true, error: None });
    assert_eq!(*host.urls.lock().unwrap(), vec!["https://auth.example/start".to_string()]);
    assert_eq!(state.requests("account/login/start"), vec![json!({"type": "chatgpt"})]);
}

#[tokio::test]
async fn login_cancel_calls_account_login_cancel() {
    let (codex, state) = codex_with(|method, _, _| {
        (method == "account/login/start")
            .then(|| Reply::Result(json!({"type": "chatgpt", "loginId": "L2", "authUrl": "https://auth.example/2"})))
    });
    let host = Arc::new(Recorder::default());
    let login = {
        let codex = Arc::clone(&codex);
        let host = Arc::clone(&host);
        tokio::spawn(async move { codex.login(host.as_ref(), None).await })
    };
    for _ in 0..100 {
        if !host.urls.lock().unwrap().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    codex.cancel_login().await.unwrap();
    let outcome = login.await.unwrap().unwrap();
    assert!(!outcome.success);
    assert_eq!(state.requests("account/login/cancel"), vec![json!({"loginId": "L2"})]);
}

// Chat continuity: one test per reseed trigger.

fn thread(generation: u64, model: &str, transcript: Vec<ChatMessage>) -> ChatThread {
    ChatThread {
        generation,
        thread_id: "T".into(),
        model: model.into(),
        system: "sys".into(),
        transcript,
    }
}

fn history() -> Vec<ChatMessage> {
    vec![msg("user", "Who is Ahab?"), msg("assistant", "The captain.")]
}

fn with_new(mut messages: Vec<ChatMessage>) -> Vec<ChatMessage> {
    messages.push(msg("user", "Why the whale?"));
    messages
}

#[test]
fn chat_continues_when_history_model_system_and_server_match() {
    let prev = thread(3, "m", history());
    assert_eq!(
        plan_chat(Some(&prev), 3, "m", "sys", &with_new(history())),
        ChatPlan::Continue { thread_id: "T".into() }
    );
}

#[test]
fn chat_reseeds_after_quill_restart() {
    assert_eq!(plan_chat(None, 1, "m", "sys", &with_new(history())), ChatPlan::Fresh);
}

#[test]
fn chat_reseeds_after_app_server_restart() {
    assert_eq!(plan_chat(Some(&thread(3, "m", history())), 4, "m", "sys", &with_new(history())), ChatPlan::Fresh);
}

#[test]
fn chat_reseeds_after_model_change() {
    assert_eq!(plan_chat(Some(&thread(3, "m", history())), 3, "other", "sys", &with_new(history())), ChatPlan::Fresh);
}

#[test]
fn chat_reseeds_after_system_prompt_change() {
    assert_eq!(
        plan_chat(Some(&thread(3, "m", history())), 3, "m", "Chapter 2 (zh)", &with_new(history())),
        ChatPlan::Fresh
    );
}

#[test]
fn chat_reseeds_after_edited_message() {
    let mut edited = history();
    edited[0].content = "Who is Ishmael?".into();
    assert_eq!(plan_chat(Some(&thread(3, "m", history())), 3, "m", "sys", &with_new(edited)), ChatPlan::Fresh);
}

#[test]
fn chat_reseeds_after_deleted_message() {
    let deleted = vec![msg("user", "Who is Ahab?")];
    assert_eq!(plan_chat(Some(&thread(3, "m", history())), 3, "m", "sys", &with_new(deleted)), ChatPlan::Fresh);
}

#[test]
fn seed_input_frames_the_transcript() {
    assert_eq!(seed_input(&[msg("user", "Hi")]), "Hi");
    let seeded = seed_input(&with_new(history()));
    assert!(seeded.starts_with("The conversation so far"));
    assert!(seeded.contains("User: Who is Ahab?"));
    assert!(seeded.contains("Assistant: The captain."));
    assert!(seeded.ends_with("Why the whale?"));
}

#[tokio::test]
async fn chat_second_turn_sends_only_the_new_message_on_the_same_thread() {
    let (codex, state) = codex();
    let host = Arc::new(Recorder::default());
    run(&codex, &host, spec("c1", vec![msg("user", "Define wit")], Some("chat"))).await;
    let second = vec![msg("user", "Define wit"), msg("assistant", RECORDED_REPLY), msg("user", "One word")];
    run(&codex, &host, spec("c2", second.clone(), Some("chat"))).await;

    assert_eq!(state.requests("thread/start").len(), 1);
    let turns = state.requests("turn/start");
    assert_eq!(turns[1]["threadId"], "thread-1");
    assert_eq!(turns[1]["input"][0]["text"], "One word");
    assert!(state.requests("thread/unsubscribe").is_empty(), "chat threads stay loaded");
    let mut expected = second;
    expected.push(msg("assistant", RECORDED_REPLY));
    assert_eq!(codex.chat_thread("chat").unwrap().transcript.len(), expected.len());
}

#[tokio::test]
async fn chat_edit_reseeds_a_fresh_thread_with_the_transcript() {
    let (codex, state) = codex();
    let host = Arc::new(Recorder::default());
    run(&codex, &host, spec("c1", vec![msg("user", "Define wit")], Some("chat"))).await;
    let edited = vec![msg("user", "Define humour"), msg("assistant", RECORDED_REPLY), msg("user", "One word")];
    run(&codex, &host, spec("c2", edited, Some("chat"))).await;
    assert_eq!(state.requests("thread/start").len(), 2);
    let text = state.requests("turn/start")[1]["input"][0]["text"].as_str().unwrap().to_string();
    assert!(text.contains("User: Define humour") && text.ends_with("One word"), "{text}");
    assert_eq!(state.requests("turn/start")[1]["threadId"], "thread-2");
}

#[tokio::test]
async fn chat_reseeds_after_app_server_restart_end_to_end() {
    let (codex, state) = codex();
    let host = Arc::new(Recorder::default());
    run(&codex, &host, spec("c1", vec![msg("user", "Define wit")], Some("chat"))).await;
    state.kill();
    tokio::time::sleep(Duration::from_millis(30)).await;
    let second = vec![msg("user", "Define wit"), msg("assistant", RECORDED_REPLY), msg("user", "One word")];
    run(&codex, &host, spec("c2", second, Some("chat"))).await;
    assert_eq!(state.launches.load(Ordering::SeqCst), 2);
    let text = state.requests("turn/start")[1]["input"][0]["text"].as_str().unwrap().to_string();
    assert!(text.starts_with("The conversation so far"), "{text}");
}

#[tokio::test]
async fn chat_failed_turn_on_the_old_thread_reseeds() {
    let (codex, state) = codex_with(|method, params, state| {
        (method == "turn/start" && params["threadId"] == "thread-1" && state.requests("turn/start").len() == 2)
            .then_some(Reply::Error("thread not found"))
    });
    let host = Arc::new(Recorder::default());
    run(&codex, &host, spec("c1", vec![msg("user", "Define wit")], Some("chat"))).await;
    let second = vec![msg("user", "Define wit"), msg("assistant", RECORDED_REPLY), msg("user", "One word")];
    run(&codex, &host, spec("c2", second, Some("chat"))).await;
    assert_eq!(host.text("c2"), RECORDED_REPLY, "no error reaches the reader");
    let turns = state.requests("turn/start");
    assert_eq!(turns.len(), 3);
    assert_eq!(turns[2]["threadId"], "thread-2");
    assert!(turns[2]["input"][0]["text"].as_str().unwrap().starts_with("The conversation so far"));
}

#[tokio::test]
async fn chat_failed_turn_forgets_the_thread() {
    let (codex, _state) = codex_with(|method, params, state| {
        (method == "turn/start" && state.requests("turn/start").len() == 2).then(|| {
            let thread = params["threadId"].as_str().unwrap();
            Reply::Then(
                json!({"turn": {"id": "t"}}),
                vec![json!({"method": "turn/completed", "params": {"threadId": thread, "turn": {"id": "t", "status": "failed", "items": [], "error": {"message": "boom"}}}})],
            )
        })
    });
    let host = Arc::new(Recorder::default());
    run(&codex, &host, spec("c1", vec![msg("user", "a")], Some("chat"))).await;
    assert!(codex.chat_thread("chat").is_some());
    let second = vec![msg("user", "a"), msg("assistant", RECORDED_REPLY), msg("user", "b")];
    run(&codex, &host, spec("c2", second, Some("chat"))).await;
    assert!(codex.chat_thread("chat").is_none());
}

#[tokio::test]
async fn models_cache_refreshes_after_account_change() {
    let calls = Arc::new(AtomicU64::new(0));
    let calls_cb = Arc::clone(&calls);
    let (codex, state) = codex_with(move |method, _, _| {
        (method == "model/list").then(|| {
            let n = calls_cb.fetch_add(1, Ordering::SeqCst);
            if n == 0 {
                Reply::Result(json!({ "data": [] }))
            } else {
                Reply::Result(fixture("model_list"))
            }
        })
    });

    // Empty catalog is not cached.
    assert!(codex.models(None).await.unwrap().models.is_empty());
    let loaded = codex.models(None).await.unwrap().models;
    assert_eq!(loaded.len(), 3);
    // Second call hits the cache.
    assert_eq!(codex.models(None).await.unwrap().models.len(), 3);
    assert_eq!(calls.load(Ordering::SeqCst), 2);

    // An account update clears the cache so the next call refetches.
    state.send(json!({"method": "account/updated", "params": {"authMode": "chatgpt"}}));
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert_eq!(codex.models(None).await.unwrap().models.len(), 3);
    assert_eq!(calls.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn login_cancels_when_browser_cannot_open() {
    struct FailingBrowser;
    impl ShellHost for FailingBrowser {
        fn emit(&self, _e: &str, _p: Value) {}
        fn emit_to(&self, _w: &str, _e: &str, _p: Value) {}
        fn open_url(&self, _u: &str) -> AppResult<()> {
            Err(AppError::Other("no browser".to_string()))
        }
        fn reveal_path(&self, _p: &Path) -> AppResult<()> {
            Ok(())
        }
    }

    let (codex, state) = codex_with(|method, _, _| {
        (method == "account/login/start")
            .then(|| Reply::Result(json!({"type": "chatgpt", "loginId": "L3", "authUrl": "https://auth.example/3"})))
    });
    let outcome = codex.login(&FailingBrowser, None).await.unwrap();
    assert!(!outcome.success);
    assert!(outcome.error.unwrap().contains("no browser"));
    assert_eq!(state.requests("account/login/cancel"), vec![json!({"loginId": "L3"})]);
}

#[tokio::test]
async fn missing_override_preserves_override_metadata_on_status() {
    let launcher: Launcher = Arc::new(|_, _| Box::pin(async { Err(StartError::NotInstalled) }));
    let codex = Arc::new(Codex::with_launcher(std::env::temp_dir().join("quill-codex-ovr"), launcher));
    let status = codex.status(Some("/custom/missing/codex".to_string())).await;
    assert_eq!(status.state, "not_installed");
    assert!(status.from_override);
    assert_eq!(status.path.as_deref(), Some("/custom/missing/codex"));
}

#[tokio::test]
async fn start_turn_fails_before_thread_start_when_no_models_are_available() {
    let (codex, state) = codex_with(|method, _, _| {
        (method == "model/list").then(|| Reply::Result(json!({ "data": [] })))
    });
    let host = Arc::new(Recorder::default());
    let mut s = spec("empty-models", vec![msg("user", "hi")], None);
    s.model_setting = None;
    let err = codex.start_turn(host, None, s).await.unwrap_err();
    assert!(err.to_string().contains("No Codex models"), "{err}");
    assert!(state.requests("thread/start").is_empty(), "must not start a thread with an empty model");
}

#[tokio::test]
async fn chat_reseeds_end_to_end_when_system_prompt_changes() {
    let (codex, state) = codex();
    let host = Arc::new(Recorder::default());
    let mut first = spec("c1", vec![msg("user", "Define wit")], Some("chat"));
    first.system = "Reading Chapter 1.".to_string();
    run(&codex, &host, first).await;

    let mut second = spec(
        "c2",
        vec![msg("user", "Define wit"), msg("assistant", RECORDED_REPLY), msg("user", "What changed?")],
        Some("chat"),
    );
    second.system = "Reading Chapter 2. Always respond in Chinese (Simplified).".to_string();
    run(&codex, &host, second).await;

    let threads = state.requests("thread/start");
    assert_eq!(threads.len(), 2, "changing chapter/language must start a fresh thread");
    assert!(threads[1]["baseInstructions"].as_str().unwrap().starts_with("Reading Chapter 2."));
    assert_eq!(state.requests("thread/unsubscribe"), vec![json!({"threadId": "thread-1"})]);
    let turns = state.requests("turn/start");
    assert_eq!(turns[1]["threadId"], "thread-2");
    assert!(turns[1]["input"][0]["text"].as_str().unwrap().starts_with("The conversation so far"));
}

#[tokio::test]
async fn turn_start_error_and_forget_chat_unsubscribe_abandoned_threads() {
    let (codex, state) = codex_with(|method, _, state| {
        (method == "turn/start" && state.requests("turn/start").len() == 2)
            .then_some(Reply::Error("bad turn"))
    });
    let host = Arc::new(Recorder::default());
    // First turn succeeds on a chat thread.
    run(&codex, &host, spec("c1", vec![msg("user", "hi")], Some("chat-a"))).await;
    // Forget releases the idle chat thread on the live server.
    codex.forget_chat("chat-a");
    for _ in 0..50 {
        if !state.requests("thread/unsubscribe").is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(state.requests("thread/unsubscribe"), vec![json!({"threadId": "thread-1"})]);

    // A fresh one-shot turn whose turn/start errors also unsubscribes its new thread.
    run(&codex, &host, spec("c2", vec![msg("user", "boom")], None)).await;
    assert!(host.text("c2").contains("bad turn"));
    assert!(
        state.requests("thread/unsubscribe").contains(&json!({"threadId": "thread-2"})),
        "abandoned thread-2 must be unsubscribed: {:?}",
        state.requests("thread/unsubscribe")
    );
}

#[tokio::test]
async fn concurrent_sends_on_same_chat_isolate_cached_thread() {
    let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
    let release_rx = Arc::new(tokio::sync::Mutex::new(Some(release_rx)));
    let (started_tx, started_rx) = tokio::sync::oneshot::channel::<()>();
    let started_tx = Arc::new(Mutex::new(Some(started_tx)));

    let (codex, state) = codex_with(move |method, params, state| {
        if method == "turn/start" && state.requests("turn/start").len() == 2 {
            let thread = params["threadId"].as_str().unwrap().to_string();
            let rx_slot = Arc::clone(&release_rx);
            let started_slot = Arc::clone(&started_tx);
            let (tx, rx) = tokio::sync::oneshot::channel();
            tokio::spawn(async move {
                if let Some(s) = started_slot.lock().unwrap().take() {
                    let _ = s.send(());
                }
                if let Some(gate) = rx_slot.lock().await.take() {
                    let _ = gate.await;
                }
                let _ = tx.send(Reply::Then(
                    json!({"turn": {"id": "turn-2"}}),
                    recorded_turn(&thread, "turn-2"),
                ));
            });
            return Some(Reply::Deferred(rx));
        }
        None
    });

    let host = Arc::new(Recorder::default());
    // Seed chat-1 on thread-1.
    run(&codex, &host, spec("c1", vec![msg("user", "first")], Some("chat-1"))).await;

    let history = vec![msg("user", "first"), msg("assistant", RECORDED_REPLY), msg("user", "second")];
    // Start second turn on chat-1 (continues thread-1, paused inside turn/start).
    codex.start_turn(host.clone(), None, spec("c2-a", history.clone(), Some("chat-1"))).await.unwrap();
    started_rx.await.unwrap();

    // Start a simultaneous turn for the same chat-1; thread-1 is busy so it must use a fresh thread.
    codex.start_turn(host.clone(), None, spec("c2-b", history, Some("chat-1"))).await.unwrap();
    host.wait_done("c2-b").await;
    assert_eq!(host.text("c2-b"), RECORDED_REPLY);

    // Release the first turn and verify it completes cleanly without interference.
    let _ = release_tx.send(());
    host.wait_done("c2-a").await;
    assert_eq!(host.text("c2-a"), RECORDED_REPLY);

    let turns = state.requests("turn/start");
    assert_eq!(turns.len(), 3);
    assert_ne!(turns[1]["threadId"], turns[2]["threadId"], "concurrent sends must not share one busy thread");
}

#[tokio::test]
async fn interrupt_while_thread_start_is_in_flight_skips_turn_start() {
    let (arrived_tx, arrived_rx) = tokio::sync::oneshot::channel::<()>();
    let arrived_tx = Arc::new(Mutex::new(Some(arrived_tx)));
    let (release_tx, release_rx) = tokio::sync::oneshot::channel::<Reply>();
    let release_rx = Arc::new(Mutex::new(Some(release_rx)));

    let (codex, state) = codex_with(move |method, _, _| {
        if method == "thread/start" {
            if let Some(a) = arrived_tx.lock().unwrap().take() {
                let _ = a.send(());
            }
            if let Some(rx) = release_rx.lock().unwrap().take() {
                return Some(Reply::Deferred(rx));
            }
        }
        None
    });

    let host = Arc::new(Recorder::default());
    codex.start_turn(host.clone(), None, spec("early-thread", vec![msg("user", "x")], None)).await.unwrap();
    arrived_rx.await.unwrap();

    // Cancel before thread/start even finishes.
    codex.interrupt("early-thread").await;
    let mut thread_res = fixture("thread_start");
    thread_res["thread"]["id"] = json!("thread-early");
    let _ = release_tx.send(Reply::Result(thread_res));

    host.wait_done("early-thread").await;
    assert!(host.text("early-thread").is_empty(), "must stream nothing after early cancel");
    assert!(state.requests("turn/start").is_empty(), "must never start a turn after early cancel");
    for _ in 0..50 {
        if !state.requests("thread/unsubscribe").is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(state.requests("thread/unsubscribe"), vec![json!({"threadId": "thread-early"})]);
}

#[tokio::test]
async fn interrupt_while_turn_start_is_in_flight_cancels_before_streaming() {
    let (arrived_tx, arrived_rx) = tokio::sync::oneshot::channel::<()>();
    let arrived_tx = Arc::new(Mutex::new(Some(arrived_tx)));
    let (release_tx, release_rx) = tokio::sync::oneshot::channel::<Reply>();
    let release_rx = Arc::new(Mutex::new(Some(release_rx)));

    let (codex, state) = codex_with(move |method, _, _| {
        if method == "turn/start" {
            if let Some(a) = arrived_tx.lock().unwrap().take() {
                let _ = a.send(());
            }
            if let Some(rx) = release_rx.lock().unwrap().take() {
                return Some(Reply::Deferred(rx));
            }
        }
        None
    });

    let host = Arc::new(Recorder::default());
    codex.start_turn(host.clone(), None, spec("early-turn", vec![msg("user", "x")], Some("chat"))).await.unwrap();
    arrived_rx.await.unwrap();

    // Cancel while turn/start is still awaiting the server's response.
    codex.interrupt("early-turn").await;
    let _ = release_tx.send(Reply::Then(
        json!({"turn": {"id": "turn-early"}}),
        recorded_turn("thread-1", "turn-early"),
    ));

    host.wait_done("early-turn").await;
    assert!(host.text("early-turn").is_empty(), "deltas must not leak after early cancel");
    assert_eq!(
        state.requests("turn/interrupt"),
        vec![json!({"threadId": "thread-1", "turnId": "turn-early"})]
    );
    assert_eq!(state.requests("thread/unsubscribe"), vec![json!({"threadId": "thread-1"})]);
}

#[tokio::test]
async fn cancel_login_while_login_start_is_in_flight_cancels_without_opening_browser() {
    let (arrived_tx, arrived_rx) = tokio::sync::oneshot::channel::<()>();
    let arrived_tx = Arc::new(Mutex::new(Some(arrived_tx)));
    let (release_tx, release_rx) = tokio::sync::oneshot::channel::<Reply>();
    let release_rx = Arc::new(Mutex::new(Some(release_rx)));

    let (codex, state) = codex_with(move |method, _, _| {
        if method == "account/login/start" {
            if let Some(a) = arrived_tx.lock().unwrap().take() {
                let _ = a.send(());
            }
            if let Some(rx) = release_rx.lock().unwrap().take() {
                return Some(Reply::Deferred(rx));
            }
        }
        None
    });

    let host = Arc::new(Recorder::default());
    let login = {
        let codex = Arc::clone(&codex);
        let host = Arc::clone(&host);
        tokio::spawn(async move { codex.login(host.as_ref(), None).await })
    };
    arrived_rx.await.unwrap();
    codex.cancel_login().await.unwrap();
    let _ = release_tx.send(Reply::Result(
        json!({"type": "chatgpt", "loginId": "L-early", "authUrl": "https://auth.example/early"}),
    ));

    let outcome = login.await.unwrap().unwrap();
    assert!(!outcome.success);
    assert!(host.urls.lock().unwrap().is_empty(), "browser must not open after early cancel");
    assert_eq!(state.requests("account/login/cancel"), vec![json!({"loginId": "L-early"})]);
}

#[tokio::test]
async fn login_returns_immediately_when_app_server_exits() {
    let (codex, state) = codex_with(|method, _, _| {
        (method == "account/login/start")
            .then(|| Reply::Result(json!({"type": "chatgpt", "loginId": "L-eof", "authUrl": "https://auth.example/eof"})))
    });
    let host = Arc::new(Recorder::default());
    let login = {
        let codex = Arc::clone(&codex);
        let host = Arc::clone(&host);
        tokio::spawn(async move { codex.login(host.as_ref(), None).await })
    };
    for _ in 0..100 {
        if !host.urls.lock().unwrap().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    state.kill();

    let outcome = tokio::time::timeout(Duration::from_secs(2), login)
        .await
        .expect("login must wake promptly on child EOF instead of waiting 15 minutes")
        .unwrap()
        .unwrap();
    assert!(!outcome.success);
    assert!(outcome.error.unwrap().contains("Codex stopped"));
}

#[cfg(unix)]
#[tokio::test]
async fn shutdown_terminates_wrapper_process_tree_and_blocks_racing_launch() {
    let (launched_tx, launched_rx) = tokio::sync::oneshot::channel::<()>();
    let launched_tx = Arc::new(Mutex::new(Some(launched_tx)));
    let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
    let release_rx = Arc::new(tokio::sync::Mutex::new(Some(release_rx)));
    let child_pid_out = Arc::new(Mutex::new(None::<i32>));
    let child_pid_writer = Arc::clone(&child_pid_out);

    let launcher: Launcher = Arc::new(move |_ovr, cwd| {
        let launched_tx = Arc::clone(&launched_tx);
        let release_rx = Arc::clone(&release_rx);
        let child_pid_writer = Arc::clone(&child_pid_writer);
        Box::pin(async move {
            // Simulate an npm wrapper (`codex.js`) spawning a child binary with inherited stdio.
            let mut cmd = tokio::process::Command::new("/bin/sh");
            cmd.args(["-c", "sleep 30 & echo $!; wait"])
                .current_dir(&cwd)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .process_group(0);
            let mut child = cmd.spawn().expect("spawn wrapper");
            let stdin = child.stdin.take().unwrap();
            let stdout = child.stdout.take().unwrap();
            let mut reader = BufReader::new(stdout);
            let mut pid_line = String::new();
            reader.read_line(&mut pid_line).await.unwrap();
            let grandchild_pid: i32 = pid_line.trim().parse().expect("grandchild pid");
            *child_pid_writer.lock().unwrap() = Some(grandchild_pid);

            if let Some(tx) = launched_tx.lock().unwrap().take() {
                let _ = tx.send(());
            }
            if let Some(rx) = release_rx.lock().await.take() {
                let _ = rx.await;
            }
            Ok(Launched {
                reader: Box::new(reader),
                writer: Box::new(stdin),
                child: Some(ManagedChild::from_spawned(child, true)),
                found: Found { path: PathBuf::from("/bin/sh"), from_override: false },
                version: Version(0, 170, 0),
                stderr_tail: Arc::new(Mutex::new(String::new())),
            })
        })
    });

    let cwd = std::env::temp_dir().join(format!("quill-codex-tree-{}", ulid::Ulid::new()));
    let codex = Arc::new(Codex::with_launcher(cwd, launcher));
    let status_task = {
        let codex = Arc::clone(&codex);
        tokio::spawn(async move { codex.status(None).await })
    };
    launched_rx.await.unwrap();
    // Shutdown races with the in-flight launcher returning a newly spawned child.
    codex.shutdown();
    let _ = release_tx.send(());

    let status = status_task.await.unwrap();
    assert_eq!(status.state, "failed");
    assert!(status.error.unwrap().contains("shutting down"));

    let grandchild_pid = child_pid_out.lock().unwrap().expect("recorded grandchild pid");
    let mut exited = false;
    for _ in 0..100 {
        // SAFETY: `kill(pid, 0)` only probes whether the grandchild still exists.
        let alive = unsafe { libc::kill(grandchild_pid, 0) } == 0;
        if !alive {
            exited = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(exited, "grandchild pid {grandchild_pid} survived wrapper teardown");
}

/// Against the installed Codex: status, the catalog and one tiny turn on
/// the cheapest model at low effort. Run with `--ignored` on a machine
/// signed in to Codex.
#[tokio::test]
#[ignore]
async fn live_installed_codex() {
    let cwd = std::env::temp_dir().join(format!("quill-codex-live-{}", ulid::Ulid::new()));
    let codex = Arc::new(Codex::new(cwd));
    let status = codex.status(None).await;
    eprintln!("status: {} {:?} {:?}", status.state, status.version, status.path);
    assert_eq!(status.state, "ready");
    let models = codex.models(None).await.unwrap().models;
    assert!(!models.is_empty());
    let host = Arc::new(Recorder::default());
    let mut s = spec("live", vec![msg("user", "Reply with the single word: ok")], None);
    s.model_setting = Some(models.last().unwrap().slug.clone());
    codex.start_turn(host.clone(), None, s).await.expect("start_turn");
    for _ in 0..1200 {
        if host.done("live") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(host.done("live"));
    eprintln!("reply: {}", host.text("live"));
    assert!(!host.text("live").contains("Error"));
    codex.shutdown();
}
