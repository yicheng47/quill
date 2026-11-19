//! Codex as an AI connection, through a `codex app-server` child process
//! that Quill starts, owns and stops.

pub mod discovery;
pub mod rpc;

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use futures::future::BoxFuture;
use serde::Serialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, BufReader};
use tokio::sync::{broadcast, mpsc};

use self::discovery::{Found, Version, MIN_VERSION};
use self::rpc::{Notification, RpcClient, RpcError};
use crate::commands::ai::{emit_stream_error, AiStreamChunk, ChatMessage};
use crate::error::{AppError, AppResult};
use crate::host::ShellHost;

pub const CODEX_NOT_INSTALLED: &str = "CODEX_NOT_INSTALLED";
pub const CODEX_NOT_SIGNED_IN: &str = "CODEX_NOT_SIGNED_IN";
pub const CODEX_TOO_OLD: &str = "CODEX_TOO_OLD";
pub const CODEX_FAILED: &str = "CODEX_FAILED";

const OPENAI_MODEL_PROVIDER: &str = "openai";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const LOGIN_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const STDERR_TAIL_BYTES: usize = 4096;

const READER_INSTRUCTIONS: &str = "You are running inside Quill, an ebook reader, not a coding environment. Answer the reader directly in plain prose. Never run commands, read files or use tools.";

/// Built-in Codex agent/tool capabilities disabled for Quill so every turn stays
/// a pure reader-text completion even under a read-only sandbox.
const DISABLED_CODEX_FEATURES: &[&str] = &[
    "shell_tool",
    "unified_exec",
    "multi_agent",
    "multi_agent_v2",
    "apps",
    "plugins",
    "hooks",
    "browser_use",
    "computer_use",
    "image_generation",
    "view_image",
    "sleep_tool",
    "memories",
    "goals",
    "skill_search",
    "tool_suggest",
];

/// CLI arguments Quill passes to `codex` so the child always uses the OpenAI
/// provider and disables built-in coding/agent capabilities regardless of
/// `~/.codex/config.toml`.
pub(crate) fn app_server_args() -> Vec<String> {
    let mut args = vec![
        "app-server".to_string(),
        "-c".to_string(),
        format!("model_provider=\"{OPENAI_MODEL_PROVIDER}\""),
        "-c".to_string(),
        "web_search=\"disabled\"".to_string(),
    ];
    for feature in DISABLED_CODEX_FEATURES {
        args.push("-c".to_string());
        args.push(format!("features.{feature}=false"));
    }
    args
}

#[derive(Debug, Clone, PartialEq)]
pub enum StartError {
    NotInstalled,
    TooOld { version: Version, path: PathBuf },
    Failed { message: String, version: Option<Version>, path: Option<PathBuf> },
}

impl StartError {
    fn sentinel(&self) -> AppError {
        AppError::Other(
            match self {
                StartError::NotInstalled => CODEX_NOT_INSTALLED,
                StartError::TooOld { .. } => CODEX_TOO_OLD,
                StartError::Failed { message, .. } => {
                    log::error!("codex: failed to start: {message}");
                    CODEX_FAILED
                }
            }
            .to_string(),
        )
    }
}

/// What Settings, the setup helper and the AI entry points show for Codex.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CodexStatus {
    /// `ready`, `not_installed`, `not_signed_in`, `too_old` or `failed`.
    pub state: &'static str,
    pub version: Option<String>,
    pub min_version: String,
    pub path: Option<String>,
    pub from_override: bool,
    pub email: Option<String>,
    pub plan: Option<String>,
    pub error: Option<String>,
}

impl CodexStatus {
    fn new(state: &'static str) -> Self {
        Self {
            state,
            version: None,
            min_version: MIN_VERSION.to_string(),
            path: None,
            from_override: false,
            email: None,
            plan: None,
            error: None,
        }
    }

    fn from_start_error(err: &StartError) -> Self {
        match err {
            StartError::NotInstalled => Self::new("not_installed"),
            StartError::TooOld { version, path } => Self {
                version: Some(version.to_string()),
                path: Some(path.display().to_string()),
                ..Self::new("too_old")
            },
            StartError::Failed { message, version, path } => Self {
                version: version.map(|v| v.to_string()),
                path: path.as_ref().map(|p| p.display().to_string()),
                error: Some(message.clone()),
                ..Self::new("failed")
            },
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CodexModel {
    pub slug: String,
    pub display_name: String,
    pub description: String,
    pub supported_reasoning_levels: Vec<String>,
    pub default_reasoning_level: String,
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CodexModelList {
    pub models: Vec<CodexModel>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct LoginOutcome {
    pub success: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
struct Account {
    signed_in: bool,
    email: Option<String>,
    plan: Option<String>,
}

fn parse_account(result: &Value) -> Account {
    let account = &result["account"];
    // Require a real OpenAI/ChatGPT account rather than accepting a null
    // account with `requiresOpenaiAuth: false` (e.g. a custom provider).
    let signed_in = matches!(account["type"].as_str(), Some("chatgpt" | "apiKey"));
    if !signed_in {
        return Account {
            signed_in: false,
            email: None,
            plan: None,
        };
    }
    Account {
        signed_in: true,
        email: account["email"].as_str().map(str::to_string),
        plan: account["planType"].as_str().map(str::to_string),
    }
}

fn parse_models(result: &Value) -> Vec<CodexModel> {
    result["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|m| !m["hidden"].as_bool().unwrap_or(false))
        .filter_map(|m| {
            Some(CodexModel {
                slug: m["id"].as_str()?.to_string(),
                display_name: m["displayName"].as_str().unwrap_or_default().to_string(),
                description: m["description"].as_str().unwrap_or_default().to_string(),
                supported_reasoning_levels: m["supportedReasoningEfforts"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|e| e["reasoningEffort"].as_str().map(str::to_string))
                    .collect(),
                default_reasoning_level: m["defaultReasoningEffort"].as_str().unwrap_or("low").to_string(),
                is_default: m["isDefault"].as_bool().unwrap_or(false),
            })
        })
        .collect()
}

/// Per-thread `config` that turns off everything that would make Codex a
/// coding agent: every MCP server and plugin the user's config lists, built-in
/// shell/agent/app capabilities, and web search.
pub fn isolation_overrides(config_read: &Value) -> Value {
    let config = &config_read["config"];
    let mut overrides = serde_json::Map::new();
    for (table, key) in [("mcp_servers", "mcp_servers"), ("plugins", "plugins")] {
        if let Some(entries) = config[table].as_object() {
            for name in entries.keys() {
                let name = if name.contains('.') { format!("\"{name}\"") } else { name.clone() };
                overrides.insert(format!("{key}.{name}.enabled"), Value::Bool(false));
            }
        }
    }
    for feature in DISABLED_CODEX_FEATURES {
        overrides.insert(format!("features.{feature}"), Value::Bool(false));
    }
    overrides.insert("web_search".to_string(), Value::String("disabled".to_string()));
    Value::Object(overrides)
}

/// The model and effort every turn sends, so a turn never inherits the
/// user's Codex defaults. An empty model means the catalog's default model;
/// an unset effort means that model's default effort.
pub fn resolve_model_and_effort(
    models: &[CodexModel],
    model_setting: Option<&str>,
    effort_setting: Option<&str>,
) -> (String, String) {
    let catalog_default = models.iter().find(|m| m.is_default).or_else(|| models.first());
    let model = model_setting
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .map(str::to_string)
        .or_else(|| catalog_default.map(|m| m.slug.clone()))
        .unwrap_or_default();
    let effort = effort_setting
        .map(str::trim)
        .filter(|e| !e.is_empty() && *e != "default")
        .map(str::to_string)
        .or_else(|| {
            models
                .iter()
                .find(|m| m.slug == model)
                .or(catalog_default)
                .map(|m| m.default_reasoning_level.clone())
        })
        .unwrap_or_else(|| "low".to_string());
    (model, effort)
}

/// A child process launched by Quill, tracked with its own process group so
/// teardown terminates both an npm wrapper (`codex.js`) and the native server
/// it spawned without ever signalling anything outside Quill's child tree.
pub struct ManagedChild {
    child: tokio::process::Child,
    pid: Option<u32>,
    #[cfg(unix)]
    own_process_group: bool,
}

impl ManagedChild {
    pub fn from_spawned(child: tokio::process::Child, #[cfg(unix)] own_process_group: bool) -> Self {
        let pid = child.id();
        Self {
            child,
            pid,
            #[cfg(unix)]
            own_process_group,
        }
    }

    fn disarm(&mut self) {
        self.pid = None;
    }

    fn terminate(mut self) {
        log::info!("codex: stopping app-server pid={:?}", self.pid);
        #[cfg(unix)]
        if self.own_process_group {
            if let Some(pid) = self.pid.filter(|&p| p > 1) {
                let pgid = -(pid as libc::pid_t);
                // SAFETY: `pgid` is strictly negative (`-pid` with `pid > 1`) and
                // identifies only the process group created via `process_group(0)`
                // for Quill's own spawned child.
                unsafe {
                    libc::kill(pgid, libc::SIGTERM);
                }
                if let Ok(handle) = tokio::runtime::Handle::try_current() {
                    handle.spawn(async move {
                        let exited =
                            tokio::time::timeout(Duration::from_millis(500), self.child.wait()).await;
                        if matches!(exited, Ok(Ok(_))) {
                            self.disarm();
                            return;
                        }
                        unsafe {
                            libc::kill(pgid, libc::SIGKILL);
                        }
                        let _ = self.child.start_kill();
                        if tokio::time::timeout(Duration::from_millis(500), self.child.wait())
                            .await
                            .is_ok()
                        {
                            self.disarm();
                        }
                    });
                    return;
                }
                unsafe {
                    libc::kill(pgid, libc::SIGKILL);
                }
                let _ = self.child.start_kill();
                self.disarm();
                return;
            }
        }
        #[cfg(windows)]
        if let Some(pid) = self.pid.filter(|&p| p > 0) {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .creation_flags(CREATE_NO_WINDOW)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn();
        }
        let _ = self.child.start_kill();
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                let _ = self.child.wait().await;
                self.disarm();
            });
        } else {
            self.disarm();
        }
    }
}

impl Drop for ManagedChild {
    fn drop(&mut self) {
        #[cfg(unix)]
        if self.own_process_group {
            if let Some(pid) = self.pid.take().filter(|&p| p > 1) {
                // SAFETY: `self.pid` is only `Some` while the direct child has not
                // been reaped, so the kernel cannot have recycled this PGID.
                unsafe {
                    libc::kill(-(pid as libc::pid_t), libc::SIGKILL);
                }
            }
        }
        let _ = self.child.start_kill();
    }
}

pub struct Launched {
    pub reader: Box<dyn AsyncRead + Send + Unpin>,
    pub writer: Box<dyn AsyncWrite + Send + Unpin>,
    pub child: Option<ManagedChild>,
    pub found: Found,
    pub version: Version,
    pub stderr_tail: Arc<Mutex<String>>,
}

pub type Launcher =
    Arc<dyn Fn(Option<String>, PathBuf) -> BoxFuture<'static, Result<Launched, StartError>> + Send + Sync>;

fn spawn_app_server(override_path: Option<String>, cwd: PathBuf) -> BoxFuture<'static, Result<Launched, StartError>> {
    Box::pin(async move {
        let found = discovery::find(override_path.as_deref())
            .await
            .ok_or(StartError::NotInstalled)?;
        let version = discovery::read_version(&found.path).await.map_err(|message| StartError::Failed {
            message,
            version: None,
            path: Some(found.path.clone()),
        })?;
        if version < MIN_VERSION {
            return Err(StartError::TooOld { version, path: found.path });
        }
        let mut cmd = discovery::command(&found.path);
        cmd.args(app_server_args())
            .current_dir(&cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        cmd.process_group(0);
        let mut child = cmd.spawn().map_err(|e| StartError::Failed {
            message: format!("could not start codex app-server: {e}"),
            version: Some(version),
            path: Some(found.path.clone()),
        })?;
        log::info!(
            "codex: started app-server pid={:?} version={version} path={}",
            child.id(),
            found.path.display()
        );
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");
        let stderr_tail = Arc::new(Mutex::new(String::new()));
        let tail = Arc::clone(&stderr_tail);
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                log::debug!("codex app-server: {line}");
                let mut tail = tail.lock().unwrap();
                tail.push_str(&line);
                tail.push('\n');
                if tail.len() > STDERR_TAIL_BYTES {
                    let mut cut = tail.len() - STDERR_TAIL_BYTES;
                    while !tail.is_char_boundary(cut) {
                        cut += 1;
                    }
                    tail.drain(..cut);
                }
            }
        });
        Ok(Launched {
            reader: Box::new(stdout),
            writer: Box::new(stdin),
            #[cfg(unix)]
            child: Some(ManagedChild::from_spawned(child, true)),
            #[cfg(not(unix))]
            child: Some(ManagedChild::from_spawned(child)),
            found,
            version,
            stderr_tail,
        })
    })
}

fn last_stderr_line(tail: &Mutex<String>) -> Option<String> {
    tail.lock()
        .unwrap()
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(str::to_string)
}

struct Session {
    rpc: Arc<RpcClient>,
    generation: u64,
    override_path: Option<String>,
    found: Found,
    version: Version,
    overrides: Value,
    account: Arc<Mutex<Option<Account>>>,
    models: Arc<tokio::sync::Mutex<Option<Vec<CodexModel>>>>,
    /// Cleared when the child's notification stream closes so login waiters wake
    /// immediately with `RecvError::Closed` instead of waiting for `LOGIN_TIMEOUT`.
    logins: Arc<Mutex<Option<broadcast::Sender<Value>>>>,
}

impl Session {
    async fn request(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        self.rpc.request(method, params, REQUEST_TIMEOUT).await
    }

    fn subscribe_logins(&self) -> Option<broadcast::Receiver<Value>> {
        self.logins.lock().unwrap().as_ref().map(|tx| tx.subscribe())
    }

    fn notify_login(&self, payload: Value) {
        if let Some(tx) = self.logins.lock().unwrap().as_ref() {
            let _ = tx.send(payload);
        }
    }

    async fn account(&self, fresh: bool) -> Result<Account, RpcError> {
        if !fresh {
            if let Some(account) = self.account.lock().unwrap().clone() {
                return Ok(account);
            }
        }
        let account = parse_account(&self.request("account/read", json!({ "refreshToken": false })).await?);
        *self.account.lock().unwrap() = Some(account.clone());
        Ok(account)
    }

    async fn models(&self) -> Result<Vec<CodexModel>, RpcError> {
        let mut cache = self.models.lock().await;
        if let Some(models) = cache.as_ref() {
            return Ok(models.clone());
        }
        let mut models = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let page = self
                .request(
                    "model/list",
                    json!({ "cursor": cursor, "modelProvider": OPENAI_MODEL_PROVIDER }),
                )
                .await?;
            models.extend(parse_models(&page));
            cursor = page["nextCursor"].as_str().map(str::to_string);
            if cursor.is_none() {
                break;
            }
        }
        if !models.is_empty() {
            *cache = Some(models.clone());
        }
        Ok(models)
    }
}

/// A chat's live Codex thread: which app server it lives on, the model and
/// system prompt it was started with, and every message it has seen.
#[derive(Debug, Clone, PartialEq)]
pub struct ChatThread {
    pub generation: u64,
    pub thread_id: String,
    pub model: String,
    pub system: String,
    pub transcript: Vec<ChatMessage>,
}

#[derive(Debug, PartialEq)]
pub enum ChatPlan {
    /// Send only the newest message on the existing thread.
    Continue { thread_id: String },
    /// Start a fresh thread seeded with the whole transcript.
    Fresh,
}

fn same_messages(a: &[ChatMessage], b: &[ChatMessage]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| x.role == y.role && x.content == y.content)
}

/// Continue a chat's thread only when it is on the running app server, uses
/// the same model and system instructions, and has seen exactly the history
/// before the new message.
pub fn plan_chat(
    prev: Option<&ChatThread>,
    generation: u64,
    model: &str,
    system: &str,
    messages: &[ChatMessage],
) -> ChatPlan {
    match prev {
        Some(thread)
            if thread.generation == generation
                && thread.model == model
                && thread.system == system
                && !messages.is_empty()
                && same_messages(&thread.transcript, &messages[..messages.len() - 1]) =>
        {
            ChatPlan::Continue { thread_id: thread.thread_id.clone() }
        }
        _ => ChatPlan::Fresh,
    }
}

/// The input of a fresh thread: the newest message alone, or the earlier
/// transcript followed by it.
pub fn seed_input(messages: &[ChatMessage]) -> String {
    let Some((last, earlier)) = messages.split_last() else {
        return String::new();
    };
    if earlier.is_empty() {
        return last.content.clone();
    }
    let mut text = String::from("The conversation so far, for context:\n");
    for message in earlier {
        let speaker = if message.role == "assistant" { "Assistant" } else { "User" };
        text.push_str(&format!("\n{speaker}: {}\n", message.content));
    }
    text.push_str("\nReply to the user's new message:\n\n");
    text.push_str(&last.content);
    text
}

/// One Codex call: Quill's system prompt and the conversation after it.
pub struct TurnSpec {
    pub system: String,
    pub messages: Vec<ChatMessage>,
    pub chat_id: Option<String>,
    pub model_setting: Option<String>,
    pub effort_setting: Option<String>,
    pub event_name: String,
}

#[derive(Default)]
struct ChildSlot {
    shutting_down: bool,
    active: Option<ManagedChild>,
}

#[derive(Default)]
struct ChatThreads {
    threads: HashMap<String, ChatThread>,
    /// Thread IDs that currently have an active turn in flight.
    busy: HashSet<String>,
}

enum TurnState {
    Starting,
    Cancelled,
    Running {
        session: Arc<Session>,
        thread_id: String,
        turn_id: String,
    },
}

struct TurnEntry {
    token: u64,
    state: TurnState,
}

enum LoginState {
    Starting {
        token: u64,
    },
    Cancelled {
        token: u64,
    },
    Active {
        token: u64,
        session: Arc<Session>,
        login_id: String,
    },
}

enum TurnEnd {
    Done(String),
    /// Stopped by `interrupt`; the `done` chunk is already sent.
    Interrupted,
    Failed(AppError),
}

pub struct Codex {
    launcher: Launcher,
    cwd: PathBuf,
    session: tokio::sync::Mutex<Option<Arc<Session>>>,
    active_session: Mutex<Option<Weak<Session>>>,
    child: Mutex<ChildSlot>,
    generation: AtomicU64,
    next_token: AtomicU64,
    chats: Mutex<ChatThreads>,
    turns: Mutex<HashMap<String, TurnEntry>>,
    login: Mutex<Option<LoginState>>,
}

impl Codex {
    /// `cwd` is the empty folder Quill owns that every thread runs in.
    pub fn new(cwd: PathBuf) -> Self {
        Self::with_launcher(cwd, Arc::new(spawn_app_server))
    }

    pub fn with_launcher(cwd: PathBuf, launcher: Launcher) -> Self {
        Self {
            launcher,
            cwd,
            session: tokio::sync::Mutex::new(None),
            active_session: Mutex::new(None),
            child: Mutex::new(ChildSlot::default()),
            generation: AtomicU64::new(0),
            next_token: AtomicU64::new(1),
            chats: Mutex::new(ChatThreads::default()),
            turns: Mutex::new(HashMap::new()),
            login: Mutex::new(None),
        }
    }

    fn kill_active_child(&self) {
        let child = self.child.lock().unwrap().active.take();
        if let Some(child) = child {
            child.terminate();
        }
    }

    fn is_turn_cancelled(&self, event_name: &str, token: u64) -> bool {
        let turns = self.turns.lock().unwrap();
        match turns.get(event_name) {
            Some(entry) if entry.token == token => matches!(entry.state, TurnState::Cancelled),
            _ => true,
        }
    }

    fn clear_turn(&self, event_name: &str, token: u64) {
        let mut turns = self.turns.lock().unwrap();
        if turns.get(event_name).is_some_and(|e| e.token == token) {
            turns.remove(event_name);
        }
    }

    fn clear_login(&self, token: u64) {
        let mut login = self.login.lock().unwrap();
        let matches = match login.as_ref() {
            Some(LoginState::Starting { token: t })
            | Some(LoginState::Cancelled { token: t })
            | Some(LoginState::Active { token: t, .. }) => *t == token,
            None => false,
        };
        if matches {
            *login = None;
        }
    }

    fn is_login_cancelled(&self, token: u64) -> bool {
        let login = self.login.lock().unwrap();
        !matches!(login.as_ref(), Some(LoginState::Starting { token: t }) if *t == token)
    }

    /// The running app server, started on first use and again after it
    /// exits or the path override changes.
    async fn session(&self, override_path: Option<String>) -> Result<Arc<Session>, StartError> {
        if self.child.lock().unwrap().shutting_down {
            return Err(StartError::Failed {
                message: "Quill is shutting down".to_string(),
                version: None,
                path: None,
            });
        }
        let override_path = override_path.map(|p| p.trim().to_string()).filter(|p| !p.is_empty());
        let mut slot = self.session.lock().await;
        if let Some(session) = slot.as_ref() {
            if !session.rpc.is_closed() && session.override_path == override_path {
                return Ok(Arc::clone(session));
            }
            *slot = None;
            *self.active_session.lock().unwrap() = None;
            self.kill_active_child();
        }

        std::fs::create_dir_all(&self.cwd).map_err(|e| StartError::Failed {
            message: format!("could not create {}: {e}", self.cwd.display()),
            version: None,
            path: None,
        })?;
        let launched = (self.launcher)(override_path.clone(), self.cwd.clone()).await?;
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let Launched { reader, writer, child, found, version, stderr_tail } = launched;
        {
            let mut child_slot = self.child.lock().unwrap();
            if child_slot.shutting_down {
                drop(child_slot);
                if let Some(child) = child {
                    child.terminate();
                }
                return Err(StartError::Failed {
                    message: "Quill is shutting down".to_string(),
                    version: Some(version),
                    path: Some(found.path),
                });
            }
            let prev = child.and_then(|c| child_slot.active.replace(c));
            drop(child_slot);
            if let Some(prev) = prev {
                prev.terminate();
            }
        }
        let (global_tx, mut global_rx) = mpsc::unbounded_channel::<Notification>();
        let close_tail = Arc::clone(&stderr_tail);
        let rpc = RpcClient::start(reader, writer, global_tx, move || match last_stderr_line(&close_tail) {
            Some(line) => format!("codex app-server exited: {line}"),
            None => "codex app-server exited".to_string(),
        });
        let failed = |message: String| StartError::Failed {
            message,
            version: Some(version),
            path: Some(found.path.clone()),
        };

        let account: Arc<Mutex<Option<Account>>> = Arc::new(Mutex::new(None));
        let models: Arc<tokio::sync::Mutex<Option<Vec<CodexModel>>>> =
            Arc::new(tokio::sync::Mutex::new(None));
        let (logins_tx, _) = broadcast::channel(8);
        let logins: Arc<Mutex<Option<broadcast::Sender<Value>>>> =
            Arc::new(Mutex::new(Some(logins_tx)));
        {
            let account = Arc::clone(&account);
            let models = Arc::clone(&models);
            let logins = Arc::clone(&logins);
            tokio::spawn(async move {
                while let Some(note) = global_rx.recv().await {
                    match note.method.as_str() {
                        "account/updated" => {
                            *account.lock().unwrap() = None;
                            *models.lock().await = None;
                        }
                        "account/login/completed" => {
                            *account.lock().unwrap() = None;
                            *models.lock().await = None;
                            if let Some(tx) = logins.lock().unwrap().as_ref() {
                                let _ = tx.send(note.params);
                            }
                        }
                        _ => {}
                    }
                }
                // Drop the sole broadcast sender when the app-server stream closes
                // so any awaiting login resolves immediately instead of timing out.
                logins.lock().unwrap().take();
            });
        }

        let handshake = async {
            rpc.request(
                "initialize",
                json!({ "clientInfo": { "name": "quill", "title": "Quill", "version": env!("CARGO_PKG_VERSION") } }),
                REQUEST_TIMEOUT,
            )
            .await?;
            rpc.notify("initialized", None).await?;
            rpc.request("config/read", json!({ "cwd": self.cwd }), REQUEST_TIMEOUT).await
        };
        let config = match handshake.await {
            Ok(config) => config,
            Err(err) => {
                tokio::time::sleep(Duration::from_millis(300)).await;
                let message = match (&err, last_stderr_line(&stderr_tail)) {
                    (RpcError::Closed(_), Some(line)) => format!("codex app-server exited: {line}"),
                    _ => err.to_string(),
                };
                self.kill_active_child();
                return Err(failed(message));
            }
        };

        if self.child.lock().unwrap().shutting_down {
            self.kill_active_child();
            return Err(failed("Quill is shutting down".to_string()));
        }

        let session = Arc::new(Session {
            rpc,
            generation,
            override_path,
            found,
            version,
            overrides: isolation_overrides(&config),
            account,
            models,
            logins,
        });
        *self.active_session.lock().unwrap() = Some(Arc::downgrade(&session));
        *slot = Some(Arc::clone(&session));
        Ok(session)
    }

    pub async fn status(&self, override_path: Option<String>) -> CodexStatus {
        let trimmed_override = override_path.as_deref().map(str::trim).filter(|p| !p.is_empty()).map(str::to_string);
        let session = match self.session(trimmed_override.clone()).await {
            Ok(session) => session,
            Err(err) => {
                let mut status = CodexStatus::from_start_error(&err);
                if let Some(path) = trimmed_override {
                    status.from_override = true;
                    if status.path.is_none() {
                        status.path = Some(path);
                    }
                }
                return status;
            }
        };
        let base = CodexStatus {
            version: Some(session.version.to_string()),
            path: Some(session.found.path.display().to_string()),
            from_override: session.found.from_override,
            ..CodexStatus::new("ready")
        };
        match session.account(true).await {
            Ok(account) if account.signed_in => CodexStatus { email: account.email, plan: account.plan, ..base },
            Ok(_) => CodexStatus { state: "not_signed_in", ..base },
            Err(err) => CodexStatus { state: "failed", error: Some(err.to_string()), ..base },
        }
    }

    pub async fn models(&self, override_path: Option<String>) -> AppResult<CodexModelList> {
        let session = self.session(override_path).await.map_err(|e| e.sentinel())?;
        let models = session.models().await.map_err(|e| AppError::Ai(e.to_string()))?;
        Ok(CodexModelList { models })
    }

    /// Sign in with ChatGPT through the app server, which stores the login in
    /// `~/.codex`. Resolves once the browser flow completes or is cancelled.
    pub async fn login(&self, host: &dyn ShellHost, override_path: Option<String>) -> AppResult<LoginOutcome> {
        let token = self.next_token.fetch_add(1, Ordering::Relaxed);
        *self.login.lock().unwrap() = Some(LoginState::Starting { token });

        let session = match self.session(override_path).await {
            Ok(session) => session,
            Err(e) => {
                self.clear_login(token);
                return Err(e.sentinel());
            }
        };
        if self.is_login_cancelled(token) {
            self.clear_login(token);
            return Ok(LoginOutcome { success: false, error: None });
        }

        let Some(mut completions) = session.subscribe_logins() else {
            self.clear_login(token);
            return Ok(LoginOutcome {
                success: false,
                error: Some("Codex stopped during sign-in".to_string()),
            });
        };

        let started = match session
            .request("account/login/start", json!({ "type": "chatgpt" }))
            .await
        {
            Ok(started) => started,
            Err(e) => {
                self.clear_login(token);
                return Err(AppError::Ai(e.to_string()));
            }
        };
        let login_id = started["loginId"].as_str().unwrap_or_default().to_string();
        let auth_url = match started["authUrl"].as_str() {
            Some(url) => url,
            None => {
                self.clear_login(token);
                return Err(AppError::Ai("Codex did not return a sign-in URL".to_string()));
            }
        };

        // Atomically transition from Starting to Active so a cancel while
        // `account/login/start` was in flight suppresses opening the browser.
        let cancelled_before_open = {
            let mut slot = self.login.lock().unwrap();
            match slot.as_ref() {
                Some(LoginState::Starting { token: t }) if *t == token => {
                    *slot = Some(LoginState::Active {
                        token,
                        session: Arc::clone(&session),
                        login_id: login_id.clone(),
                    });
                    false
                }
                _ => {
                    if matches!(
                        slot.as_ref(),
                        Some(LoginState::Cancelled { token: t }) if *t == token
                    ) {
                        *slot = None;
                    }
                    true
                }
            }
        };
        if cancelled_before_open {
            if !login_id.is_empty() {
                let _ = session.request("account/login/cancel", json!({ "loginId": login_id })).await;
            }
            return Ok(LoginOutcome { success: false, error: None });
        }

        if let Err(e) = host.open_url(auth_url) {
            log::warn!("codex: could not open the sign-in page: {e}");
            self.clear_login(token);
            let _ = session.request("account/login/cancel", json!({ "loginId": login_id })).await;
            return Ok(LoginOutcome {
                success: false,
                error: Some(format!("Could not open the sign-in page: {e}")),
            });
        }

        let outcome = tokio::time::timeout(LOGIN_TIMEOUT, async {
            loop {
                match completions.recv().await {
                    Ok(params) => {
                        let id = params["loginId"].as_str();
                        if id.is_none() || id == Some(login_id.as_str()) {
                            return LoginOutcome {
                                success: params["success"].as_bool().unwrap_or(false),
                                error: params["error"].as_str().map(str::to_string),
                            };
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => {
                        return LoginOutcome {
                            success: false,
                            error: Some("Codex stopped during sign-in".to_string()),
                        }
                    }
                }
            }
        })
        .await
        .unwrap_or(LoginOutcome { success: false, error: Some("Sign-in timed out".to_string()) });
        self.clear_login(token);
        *session.account.lock().unwrap() = None;
        *session.models.lock().await = None;
        Ok(outcome)
    }

    pub async fn cancel_login(&self) -> AppResult<()> {
        let active = {
            let mut slot = self.login.lock().unwrap();
            match slot.take() {
                Some(LoginState::Starting { token }) => {
                    *slot = Some(LoginState::Cancelled { token });
                    None
                }
                Some(LoginState::Cancelled { token }) => {
                    *slot = Some(LoginState::Cancelled { token });
                    None
                }
                Some(LoginState::Active { session, login_id, .. }) => Some((session, login_id)),
                None => None,
            }
        };
        if let Some((session, login_id)) = active {
            if let Err(e) = session.request("account/login/cancel", json!({ "loginId": login_id })).await {
                log::warn!("codex: login cancel failed: {e}");
            }
            session.notify_login(json!({ "loginId": login_id, "success": false }));
        }
        Ok(())
    }

    /// Stop streaming the call on `event_name`, if one is starting or running.
    pub async fn interrupt(&self, event_name: &str) {
        let target = {
            let mut turns = self.turns.lock().unwrap();
            match turns.get_mut(event_name) {
                Some(entry) => match &entry.state {
                    TurnState::Starting => {
                        entry.state = TurnState::Cancelled;
                        None
                    }
                    TurnState::Cancelled => None,
                    TurnState::Running { session, thread_id, turn_id } => {
                        Some((Arc::clone(session), thread_id.clone(), turn_id.clone()))
                    }
                },
                None => None,
            }
        };
        if let Some((session, thread_id, turn_id)) = target {
            if let Err(e) = session
                .request("turn/interrupt", json!({ "threadId": thread_id, "turnId": turn_id }))
                .await
            {
                log::warn!("codex: interrupt failed: {e}");
            }
        }
    }

    /// Forget a chat's thread, so its next Codex turn starts fresh, and release
    /// the loaded server thread if it is idle on the current app server.
    pub fn forget_chat(&self, chat_id: &str) {
        let removed = {
            let mut chats = self.chats.lock().unwrap();
            chats
                .threads
                .remove(chat_id)
                .filter(|t| !chats.busy.contains(&t.thread_id))
        };
        let Some(prev) = removed else {
            return;
        };
        let session = self.active_session.lock().unwrap().as_ref().and_then(Weak::upgrade);
        if let Some(session) = session {
            if session.generation == prev.generation && !session.rpc.is_closed() {
                if let Ok(handle) = tokio::runtime::Handle::try_current() {
                    let thread_id = prev.thread_id;
                    handle.spawn(async move {
                        let _ = session
                            .request("thread/unsubscribe", json!({ "threadId": thread_id }))
                            .await;
                    });
                }
            }
        }
    }

    pub fn shutdown(&self) {
        let child = {
            let mut slot = self.child.lock().unwrap();
            slot.shutting_down = true;
            slot.active.take()
        };
        if let Some(child) = child {
            child.terminate();
        }
    }

    /// Check that Codex can take the call, then stream it into
    /// `spec.event_name` from a background task.
    pub async fn start_turn(
        self: &Arc<Self>,
        host: Arc<dyn ShellHost>,
        override_path: Option<String>,
        spec: TurnSpec,
    ) -> AppResult<()> {
        let token = self.next_token.fetch_add(1, Ordering::Relaxed);
        let event_name = spec.event_name.clone();
        self.turns.lock().unwrap().insert(
            event_name.clone(),
            TurnEntry { token, state: TurnState::Starting },
        );

        let session = match self.session(override_path).await {
            Ok(session) => session,
            Err(e) => {
                self.clear_turn(&event_name, token);
                return Err(e.sentinel());
            }
        };
        if self.is_turn_cancelled(&event_name, token) {
            self.clear_turn(&event_name, token);
            host.emit_json(&event_name, &AiStreamChunk { delta: String::new(), done: true });
            return Ok(());
        }

        match session.account(false).await {
            Ok(account) if account.signed_in => {}
            Ok(_) => {
                self.clear_turn(&event_name, token);
                return Err(AppError::Other(CODEX_NOT_SIGNED_IN.to_string()));
            }
            Err(e) => {
                self.clear_turn(&event_name, token);
                return Err(AppError::Ai(e.to_string()));
            }
        }
        if self.is_turn_cancelled(&event_name, token) {
            self.clear_turn(&event_name, token);
            host.emit_json(&event_name, &AiStreamChunk { delta: String::new(), done: true });
            return Ok(());
        }

        let models = match session.models().await {
            Ok(models) => models,
            Err(e) => {
                self.clear_turn(&event_name, token);
                return Err(AppError::Ai(e.to_string()));
            }
        };
        let (model, effort) =
            resolve_model_and_effort(&models, spec.model_setting.as_deref(), spec.effort_setting.as_deref());
        if model.is_empty() {
            self.clear_turn(&event_name, token);
            return Err(AppError::Ai("No Codex models are available for this account.".to_string()));
        }
        if self.is_turn_cancelled(&event_name, token) {
            self.clear_turn(&event_name, token);
            host.emit_json(&event_name, &AiStreamChunk { delta: String::new(), done: true });
            return Ok(());
        }
        log::info!("codex: turn model={model} effort={effort} chat={}", spec.chat_id.is_some());

        let codex = Arc::clone(self);
        tokio::spawn(async move {
            let event_name = spec.event_name.clone();
            if let TurnEnd::Failed(err) = codex.run_turn(&session, host.as_ref(), spec, model, effort, token).await {
                emit_stream_error(host.as_ref(), &event_name, &err);
            }
        });
        Ok(())
    }

    async fn start_thread(&self, session: &Session, system: &str, model: &str) -> Result<String, RpcError> {
        let started = session
            .request(
                "thread/start",
                json!({
                    "cwd": self.cwd,
                    "ephemeral": true,
                    "sandbox": "read-only",
                    "approvalPolicy": "never",
                    "modelProvider": OPENAI_MODEL_PROVIDER,
                    "baseInstructions": format!("{system}\n\n{READER_INSTRUCTIONS}"),
                    "model": model,
                    "config": session.overrides,
                }),
            )
            .await?;
        started["thread"]["id"]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| RpcError::Closed("thread/start returned no thread id".to_string()))
    }

    fn release_busy_thread(&self, busy_thread: &mut Option<String>) {
        if let Some(id) = busy_thread.take() {
            self.chats.lock().unwrap().busy.remove(&id);
        }
    }

    async fn run_turn(
        &self,
        session: &Arc<Session>,
        host: &dyn ShellHost,
        spec: TurnSpec,
        model: String,
        effort: String,
        token: u64,
    ) -> TurnEnd {
        let TurnSpec { system, messages, chat_id, event_name, .. } = spec;
        if self.is_turn_cancelled(&event_name, token) {
            self.clear_turn(&event_name, token);
            host.emit_json(&event_name, &AiStreamChunk { delta: String::new(), done: true });
            return TurnEnd::Interrupted;
        }

        let (mut plan, mut claimed_busy, stale_to_unsubscribe) = {
            let mut chats = self.chats.lock().unwrap();
            let previous = chat_id.as_ref().and_then(|id| chats.threads.get(id).cloned());
            let planned = match &chat_id {
                Some(_) => plan_chat(previous.as_ref(), session.generation, &model, &system, &messages),
                None => ChatPlan::Fresh,
            };
            match planned {
                ChatPlan::Continue { thread_id } => {
                    if chats.busy.insert(thread_id.clone()) {
                        (ChatPlan::Continue { thread_id: thread_id.clone() }, Some(thread_id), None)
                    } else {
                        // Another send is already streaming on this chat's cached thread;
                        // isolate this concurrent turn on its own fresh thread.
                        (ChatPlan::Fresh, None, None)
                    }
                }
                ChatPlan::Fresh => {
                    let stale = previous
                        .filter(|p| p.generation == session.generation && !chats.busy.contains(&p.thread_id))
                        .map(|p| p.thread_id);
                    if stale.is_some() {
                        if let Some(id) = &chat_id {
                            chats.threads.remove(id);
                        }
                    }
                    (ChatPlan::Fresh, None, stale)
                }
            }
        };

        if let Some(stale_id) = stale_to_unsubscribe {
            let _ = session.request("thread/unsubscribe", json!({ "threadId": stale_id })).await;
        }

        let (thread_id, turn_id, sub_id, mut notes) = loop {
            if self.is_turn_cancelled(&event_name, token) {
                self.release_busy_thread(&mut claimed_busy);
                self.clear_turn(&event_name, token);
                host.emit_json(&event_name, &AiStreamChunk { delta: String::new(), done: true });
                return TurnEnd::Interrupted;
            }
            let (thread_id, input, is_fresh) = match &plan {
                ChatPlan::Continue { thread_id } => (
                    thread_id.clone(),
                    messages.last().map(|m| m.content.clone()).unwrap_or_default(),
                    false,
                ),
                ChatPlan::Fresh => match self.start_thread(session, &system, &model).await {
                    Ok(id) => (id, seed_input(&messages), true),
                    Err(e) => {
                        self.release_busy_thread(&mut claimed_busy);
                        self.clear_turn(&event_name, token);
                        return self.fail_turn(chat_id.as_deref(), AppError::Ai(e.to_string()));
                    }
                },
            };

            if self.is_turn_cancelled(&event_name, token) {
                self.release_busy_thread(&mut claimed_busy);
                self.clear_turn(&event_name, token);
                if is_fresh && !session.rpc.is_closed() {
                    let _ = session.request("thread/unsubscribe", json!({ "threadId": thread_id })).await;
                }
                host.emit_json(&event_name, &AiStreamChunk { delta: String::new(), done: true });
                return TurnEnd::Interrupted;
            }

            let (sub_id, notes) = session.rpc.subscribe(&thread_id);
            let started = session
                .request(
                    "turn/start",
                    json!({
                        "threadId": thread_id,
                        "model": model,
                        "effort": effort,
                        "input": [{ "type": "text", "text": input }],
                    }),
                )
                .await;
            match started {
                Ok(result) => {
                    let turn_id = result["turn"]["id"].as_str().unwrap_or_default().to_string();
                    break (thread_id, turn_id, sub_id, notes);
                }
                Err(e) => {
                    session.rpc.unsubscribe(&thread_id, sub_id);
                    self.release_busy_thread(&mut claimed_busy);
                    if !session.rpc.is_closed() {
                        let _ = session.request("thread/unsubscribe", json!({ "threadId": thread_id })).await;
                    }
                    if matches!(plan, ChatPlan::Continue { .. }) && !session.rpc.is_closed() {
                        log::warn!("codex: continuing chat thread failed ({e}); starting a fresh one");
                        plan = ChatPlan::Fresh;
                        continue;
                    }
                    self.clear_turn(&event_name, token);
                    return self.fail_turn(chat_id.as_deref(), AppError::Ai(e.to_string()));
                }
            }
        };

        // Atomically publish the active turn IDs or observe a cancellation that
        // arrived while `turn/start` was in flight.
        let cancelled_during_start = {
            let mut turns = self.turns.lock().unwrap();
            match turns.get_mut(&event_name) {
                Some(entry) if entry.token == token && matches!(entry.state, TurnState::Starting) => {
                    entry.state = TurnState::Running {
                        session: Arc::clone(session),
                        thread_id: thread_id.clone(),
                        turn_id: turn_id.clone(),
                    };
                    false
                }
                _ => {
                    if turns.get(&event_name).is_some_and(|e| e.token == token) {
                        turns.remove(&event_name);
                    }
                    true
                }
            }
        };

        if cancelled_during_start {
            session.rpc.unsubscribe(&thread_id, sub_id);
            self.release_busy_thread(&mut claimed_busy);
            if !session.rpc.is_closed() {
                if let Err(e) = session
                    .request("turn/interrupt", json!({ "threadId": thread_id, "turnId": turn_id }))
                    .await
                {
                    log::warn!("codex: early interrupt failed: {e}");
                }
                let _ = session.request("thread/unsubscribe", json!({ "threadId": thread_id })).await;
            }
            if let Some(chat_id) = chat_id.as_deref() {
                self.forget_chat(chat_id);
            }
            host.emit_json(&event_name, &AiStreamChunk { delta: String::new(), done: true });
            return TurnEnd::Interrupted;
        }

        let end = stream_turn(&mut notes, host, &event_name, &turn_id).await;
        self.clear_turn(&event_name, token);
        session.rpc.unsubscribe(&thread_id, sub_id);
        self.release_busy_thread(&mut claimed_busy);

        match (end, chat_id) {
            (TurnEnd::Done(reply), Some(chat_id)) => {
                let mut transcript = messages;
                transcript.push(ChatMessage { role: "assistant".to_string(), content: reply.clone() });
                let replaced = {
                    let mut chats = self.chats.lock().unwrap();
                    let prev = chats.threads.insert(
                        chat_id,
                        ChatThread {
                            generation: session.generation,
                            thread_id: thread_id.clone(),
                            model,
                            system,
                            transcript,
                        },
                    );
                    prev.filter(|p| {
                        p.thread_id != thread_id
                            && p.generation == session.generation
                            && !chats.busy.contains(&p.thread_id)
                    })
                };
                if let Some(old) = replaced {
                    let _ = session
                        .request("thread/unsubscribe", json!({ "threadId": old.thread_id }))
                        .await;
                }
                TurnEnd::Done(reply)
            }
            (TurnEnd::Done(reply), None) => {
                let _ = session.request("thread/unsubscribe", json!({ "threadId": thread_id })).await;
                TurnEnd::Done(reply)
            }
            (TurnEnd::Interrupted, chat_id) => {
                if let Some(chat_id) = chat_id {
                    self.forget_chat(&chat_id);
                }
                let _ = session.request("thread/unsubscribe", json!({ "threadId": thread_id })).await;
                TurnEnd::Interrupted
            }
            (TurnEnd::Failed(err), chat_id) => {
                if !session.rpc.is_closed() {
                    let _ = session.request("thread/unsubscribe", json!({ "threadId": thread_id })).await;
                }
                self.fail_turn(chat_id.as_deref(), err)
            }
        }
    }

    fn fail_turn(&self, chat_id: Option<&str>, err: AppError) -> TurnEnd {
        if let Some(chat_id) = chat_id {
            self.forget_chat(chat_id);
        }
        TurnEnd::Failed(err)
    }

    #[cfg(test)]
    fn chat_thread(&self, chat_id: &str) -> Option<ChatThread> {
        self.chats.lock().unwrap().threads.get(chat_id).cloned()
    }
}

fn turn_error(error: &Value) -> AppError {
    if error["codexErrorInfo"].as_str() == Some("unauthorized") {
        return AppError::Other(CODEX_NOT_SIGNED_IN.to_string());
    }
    AppError::Ai(error["message"].as_str().unwrap_or("Codex turn failed").to_string())
}

/// Forward a turn's answer deltas to the event channel until it completes.
async fn stream_turn(
    notes: &mut mpsc::UnboundedReceiver<Notification>,
    host: &dyn ShellHost,
    event_name: &str,
    turn_id: &str,
) -> TurnEnd {
    let mut reply = String::new();
    let mut commentary: HashSet<String> = HashSet::new();
    let mut last_error: Option<AppError> = None;
    while let Some(note) = notes.recv().await {
        let params = &note.params;
        if params["turnId"].as_str().is_some_and(|id| id != turn_id) {
            continue;
        }
        match note.method.as_str() {
            "item/started" => {
                let item = &params["item"];
                match item["type"].as_str() {
                    Some("agentMessage") if item["phase"].as_str() == Some("commentary") => {
                        if let Some(id) = item["id"].as_str() {
                            commentary.insert(id.to_string());
                        }
                    }
                    Some("agentMessage" | "userMessage" | "reasoning") | None => {}
                    Some(other) => log::warn!("codex: turn produced a {other} item"),
                }
            }
            "item/agentMessage/delta" => {
                if params["itemId"].as_str().is_some_and(|id| commentary.contains(id)) {
                    continue;
                }
                if let Some(delta) = params["delta"].as_str() {
                    reply.push_str(delta);
                    host.emit_json(event_name, &AiStreamChunk { delta: delta.to_string(), done: false });
                }
            }
            "error" if !params["willRetry"].as_bool().unwrap_or(false) => {
                last_error = Some(turn_error(&params["error"]));
            }
            "turn/completed" => {
                let turn = &params["turn"];
                if turn["id"].as_str().is_some_and(|id| id != turn_id) {
                    continue;
                }
                return match turn["status"].as_str() {
                    Some("failed") => TurnEnd::Failed(
                        last_error.unwrap_or_else(|| turn_error(&turn["error"])),
                    ),
                    status => {
                        host.emit_json(event_name, &AiStreamChunk { delta: String::new(), done: true });
                        if status == Some("interrupted") {
                            TurnEnd::Interrupted
                        } else {
                            TurnEnd::Done(reply)
                        }
                    }
                };
            }
            _ => {}
        }
    }
    TurnEnd::Failed(AppError::Ai("Codex stopped unexpectedly. Try again.".to_string()))
}

#[cfg(test)]
mod tests;
