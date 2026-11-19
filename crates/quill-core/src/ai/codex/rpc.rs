//! Line-delimited JSON-RPC over the app server's stdio.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};

#[derive(Debug, Clone, PartialEq)]
pub enum RpcError {
    /// The server answered the request with a JSON-RPC error.
    Server { code: i64, message: String },
    /// The connection is gone; the reason says why.
    Closed(String),
    Timeout,
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RpcError::Server { code, message } => write!(f, "{message} (code {code})"),
            RpcError::Closed(reason) => write!(f, "{reason}"),
            RpcError::Timeout => write!(f, "Codex did not answer in time"),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Notification {
    pub method: String,
    pub params: Value,
}

type Pending = HashMap<u64, oneshot::Sender<Result<Value, RpcError>>>;
type ThreadSubscribers = HashMap<String, Vec<(u64, mpsc::UnboundedSender<Notification>)>>;

pub struct RpcClient {
    writer: tokio::sync::Mutex<Box<dyn AsyncWrite + Send + Unpin>>,
    next_id: AtomicU64,
    next_sub_id: AtomicU64,
    pending: Arc<Mutex<Pending>>,
    threads: Arc<Mutex<ThreadSubscribers>>,
    closed: Arc<Mutex<Option<String>>>,
}

impl RpcClient {
    /// Start reading `reader` in the background. Notifications that carry a
    /// `threadId` go to that thread's subscribers; every other notification
    /// goes to `global`. `close_reason` explains an end of stream.
    pub fn start(
        reader: impl AsyncRead + Send + Unpin + 'static,
        writer: impl AsyncWrite + Send + Unpin + 'static,
        global: mpsc::UnboundedSender<Notification>,
        close_reason: impl Fn() -> String + Send + 'static,
    ) -> Arc<Self> {
        let client = Arc::new(Self {
            writer: tokio::sync::Mutex::new(Box::new(writer)),
            next_id: AtomicU64::new(1),
            next_sub_id: AtomicU64::new(1),
            pending: Arc::new(Mutex::new(HashMap::new())),
            threads: Arc::new(Mutex::new(HashMap::new())),
            closed: Arc::new(Mutex::new(None)),
        });

        let pending = Arc::clone(&client.pending);
        let threads = Arc::clone(&client.threads);
        let closed = Arc::clone(&client.closed);
        let replies = Arc::downgrade(&client);
        tokio::spawn(async move {
            let mut lines = BufReader::new(reader).lines();
            loop {
                let line = match lines.next_line().await {
                    Ok(Some(line)) => line,
                    Ok(None) | Err(_) => break,
                };
                let Ok(message) = serde_json::from_str::<Value>(&line) else {
                    log::warn!("codex: ignoring non-JSON line from app-server");
                    continue;
                };
                match route(&message) {
                    Route::Response(id) => {
                        let result = match message.get("error") {
                            Some(err) => Err(RpcError::Server {
                                code: err["code"].as_i64().unwrap_or(0),
                                message: err["message"].as_str().unwrap_or("unknown error").to_string(),
                            }),
                            None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
                        };
                        if let Some(tx) = pending.lock().unwrap().remove(&id) {
                            let _ = tx.send(result);
                        }
                    }
                    Route::ServerRequest(id, method) => {
                        log::warn!("codex: declining server request {method}");
                        if let Some(client) = replies.upgrade() {
                            let reply = json!({
                                "id": id,
                                "error": { "code": -32601, "message": "Quill does not handle this request" },
                            });
                            let _ = client.write(&reply).await;
                        }
                    }
                    Route::Notification(notification) => {
                        let thread_id = notification.params["threadId"].as_str().map(str::to_string);
                        let senders = thread_id
                            .and_then(|id| threads.lock().unwrap().get(&id).cloned())
                            .unwrap_or_default();
                        if senders.is_empty() {
                            let _ = global.send(notification);
                        } else {
                            for (_, tx) in senders {
                                let _ = tx.send(notification.clone());
                            }
                        }
                    }
                    Route::Ignore => {}
                }
            }
            let reason = close_reason();
            *closed.lock().unwrap() = Some(reason.clone());
            for (_, tx) in pending.lock().unwrap().drain() {
                let _ = tx.send(Err(RpcError::Closed(reason.clone())));
            }
            threads.lock().unwrap().clear();
        });

        client
    }

    pub fn is_closed(&self) -> bool {
        self.closed.lock().unwrap().is_some()
    }

    async fn write(&self, message: &Value) -> Result<(), RpcError> {
        let mut line = serde_json::to_string(message).expect("serialize JSON-RPC message");
        line.push('\n');
        let mut writer = self.writer.lock().await;
        let written = async {
            writer.write_all(line.as_bytes()).await?;
            writer.flush().await
        }
        .await;
        written.map_err(|e| RpcError::Closed(format!("could not write to Codex: {e}")))
    }

    pub async fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, RpcError> {
        if let Some(reason) = self.closed.lock().unwrap().clone() {
            return Err(RpcError::Closed(reason));
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        if let Err(e) = self.write(&json!({ "id": id, "method": method, "params": params })).await {
            self.pending.lock().unwrap().remove(&id);
            return Err(e);
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(RpcError::Closed("Codex connection closed".to_string())),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err(RpcError::Timeout)
            }
        }
    }

    pub async fn notify(&self, method: &str, params: Option<Value>) -> Result<(), RpcError> {
        let mut message = json!({ "method": method });
        if let Some(params) = params {
            message["params"] = params;
        }
        self.write(&message).await
    }

    /// Receive the notifications for one thread until `unsubscribe` or the
    /// connection closes (the receiver then yields `None`). Multiple
    /// subscribers on the same thread stay isolated by subscription ID.
    pub fn subscribe(&self, thread_id: &str) -> (u64, mpsc::UnboundedReceiver<Notification>) {
        let sub_id = self.next_sub_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::unbounded_channel();
        let mut threads = self.threads.lock().unwrap();
        if !self.is_closed() {
            threads.entry(thread_id.to_string()).or_default().push((sub_id, tx));
        }
        (sub_id, rx)
    }

    pub fn unsubscribe(&self, thread_id: &str, sub_id: u64) {
        let mut threads = self.threads.lock().unwrap();
        if let Some(subs) = threads.get_mut(thread_id) {
            subs.retain(|(id, _)| *id != sub_id);
            if subs.is_empty() {
                threads.remove(thread_id);
            }
        }
    }
}

enum Route {
    Response(u64),
    ServerRequest(Value, String),
    Notification(Notification),
    Ignore,
}

fn route(message: &Value) -> Route {
    let method = message.get("method").and_then(Value::as_str);
    let id = message.get("id");
    match (method, id) {
        (Some(method), Some(id)) => Route::ServerRequest(id.clone(), method.to_string()),
        (Some(method), None) => Route::Notification(Notification {
            method: method.to_string(),
            params: message.get("params").cloned().unwrap_or(Value::Null),
        }),
        (None, Some(id)) => id.as_u64().map_or(Route::Ignore, Route::Response),
        (None, None) => Route::Ignore,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{duplex, AsyncBufReadExt};

    #[tokio::test]
    async fn routes_responses_notifications_and_server_requests() {
        let (client_side, server_side) = duplex(1 << 16);
        let (client_read, client_write) = tokio::io::split(client_side);
        let (server_read, mut server_write) = tokio::io::split(server_side);
        let (global_tx, mut global_rx) = mpsc::unbounded_channel();
        let client = RpcClient::start(client_read, client_write, global_tx, || "gone".to_string());

        let mut server_lines = BufReader::new(server_read).lines();
        let (_sub_id, mut thread_rx) = client.subscribe("t1");
        let request = {
            let client = Arc::clone(&client);
            tokio::spawn(async move { client.request("model/list", json!({}), Duration::from_secs(5)).await })
        };

        let sent: Value = serde_json::from_str(&server_lines.next_line().await.unwrap().unwrap()).unwrap();
        assert_eq!(sent["method"], "model/list");
        let id = sent["id"].clone();

        for message in [
            json!({"method": "item/agentMessage/delta", "params": {"threadId": "t1", "delta": "Hi"}}),
            json!({"method": "account/updated", "params": {"authMode": "chatgpt"}}),
            json!({"id": 99, "method": "item/commandExecution/requestApproval", "params": {"threadId": "t1"}}),
            json!({"id": id, "result": {"data": []}}),
        ] {
            server_write.write_all(format!("{message}\n").as_bytes()).await.unwrap();
        }

        assert_eq!(request.await.unwrap().unwrap(), json!({"data": []}));
        assert_eq!(thread_rx.recv().await.unwrap().params["delta"], "Hi");
        assert_eq!(global_rx.recv().await.unwrap().method, "account/updated");
        let declined: Value = serde_json::from_str(&server_lines.next_line().await.unwrap().unwrap()).unwrap();
        assert_eq!(declined["id"], 99);
        assert_eq!(declined["error"]["code"], -32601);
    }

    #[tokio::test]
    async fn multiple_subscribers_on_one_thread_do_not_overwrite_each_other() {
        let (client_side, server_side) = duplex(1 << 16);
        let (client_read, client_write) = tokio::io::split(client_side);
        let (_server_read, mut server_write) = tokio::io::split(server_side);
        let (global_tx, _global_rx) = mpsc::unbounded_channel();
        let client = RpcClient::start(client_read, client_write, global_tx, || "gone".to_string());

        let (sub_a, mut rx_a) = client.subscribe("t1");
        let (sub_b, mut rx_b) = client.subscribe("t1");
        let first = json!({"method": "item/agentMessage/delta", "params": {"threadId": "t1", "delta": "one"}});
        server_write.write_all(format!("{first}\n").as_bytes()).await.unwrap();
        assert_eq!(rx_a.recv().await.unwrap().params["delta"], "one");
        assert_eq!(rx_b.recv().await.unwrap().params["delta"], "one");

        client.unsubscribe("t1", sub_a);
        let second = json!({"method": "item/agentMessage/delta", "params": {"threadId": "t1", "delta": "two"}});
        server_write.write_all(format!("{second}\n").as_bytes()).await.unwrap();
        assert_eq!(rx_b.recv().await.unwrap().params["delta"], "two");
        assert!(rx_a.try_recv().is_err());
        client.unsubscribe("t1", sub_b);
    }

    #[tokio::test]
    async fn closing_the_stream_fails_pending_requests_and_ends_subscriptions() {
        let (client_side, server_side) = duplex(1 << 16);
        let (client_read, client_write) = tokio::io::split(client_side);
        let (global_tx, _global_rx) = mpsc::unbounded_channel();
        let client = RpcClient::start(client_read, client_write, global_tx, || "app-server exited".to_string());
        let (_sub_id, mut thread_rx) = client.subscribe("t1");
        let request = {
            let client = Arc::clone(&client);
            tokio::spawn(async move { client.request("thread/start", json!({}), Duration::from_secs(5)).await })
        };
        tokio::task::yield_now().await;
        drop(server_side);

        assert_eq!(
            request.await.unwrap(),
            Err(RpcError::Closed("app-server exited".to_string()))
        );
        assert!(thread_rx.recv().await.is_none());
        assert!(client.is_closed());
        assert_eq!(
            client.request("x", json!({}), Duration::from_secs(1)).await,
            Err(RpcError::Closed("app-server exited".to_string()))
        );
    }

    #[tokio::test]
    async fn request_times_out() {
        let (client_side, _server_side) = duplex(1 << 16);
        let (client_read, client_write) = tokio::io::split(client_side);
        let (global_tx, _global_rx) = mpsc::unbounded_channel();
        let client = RpcClient::start(client_read, client_write, global_tx, String::new);
        assert_eq!(
            client.request("x", json!({}), Duration::from_millis(30)).await,
            Err(RpcError::Timeout)
        );
    }
}
