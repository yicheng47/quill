use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::secrets::Secrets;

const CODEX_BASE_URL: &str = "https://chatgpt.com/backend-api/codex";
const FETCH_TIMEOUT: Duration = Duration::from_secs(5);
const CACHE_TTL: Duration = Duration::from_secs(300);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CodexModel {
    pub slug: String,
    pub display_name: String,
    pub description: String,
    pub supported_reasoning_levels: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CodexModelList {
    pub models: Vec<CodexModel>,
    pub from_fallback: bool,
}

/// The live catalog (codex-cli 0.146.0) ships reasoning levels as objects
/// (`{"effort": "low", "description": "..."}`); the bare-string form is
/// accepted too in case the server ever simplifies the shape.
#[derive(Deserialize)]
#[serde(untagged)]
enum RawReasoningLevel {
    Effort(String),
    Preset { effort: String },
}

impl RawReasoningLevel {
    fn into_effort(self) -> String {
        match self {
            RawReasoningLevel::Effort(effort) => effort,
            RawReasoningLevel::Preset { effort } => effort,
        }
    }
}

#[derive(Deserialize)]
struct RawModel {
    slug: String,
    display_name: Option<String>,
    description: Option<String>,
    visibility: Option<String>,
    supported_reasoning_levels: Option<Vec<RawReasoningLevel>>,
}

#[derive(Deserialize)]
struct ModelsEnvelope {
    models: Vec<RawModel>,
}

/// Parse the `/models` response envelope, dropping entries the server marks
/// hidden. Unknown or missing `visibility` values stay visible — erring
/// toward showing avoids an empty picker if the server adds a new variant.
fn parse_models_response(body: &str) -> AppResult<Vec<CodexModel>> {
    let envelope: ModelsEnvelope =
        serde_json::from_str(body).map_err(|e| AppError::Ai(format!("models parse: {e}")))?;
    Ok(envelope
        .models
        .into_iter()
        .filter(|m| {
            !matches!(
                m.visibility.as_deref(),
                Some("hidden") | Some("hide")
            )
        })
        .map(|m| CodexModel {
            display_name: m.display_name.unwrap_or_else(|| m.slug.clone()),
            slug: m.slug,
            description: m.description.unwrap_or_default(),
            supported_reasoning_levels: m
                .supported_reasoning_levels
                .unwrap_or_default()
                .into_iter()
                .map(RawReasoningLevel::into_effort)
                .collect(),
        })
        .collect())
}

/// Bundled list used before OAuth connect or when the fetch fails. Empty
/// `supported_reasoning_levels` makes the frontend fall back to the effort
/// union.
fn fallback_models() -> Vec<CodexModel> {
    [
        ("gpt-5.3-codex", "GPT-5.3 Codex"),
        ("gpt-5.2-codex", "GPT-5.2 Codex"),
        ("gpt-5.1-codex-max", "GPT-5.1 Codex Max"),
    ]
    .into_iter()
    .map(|(slug, name)| CodexModel {
        slug: slug.to_string(),
        display_name: name.to_string(),
        description: String::new(),
        supported_reasoning_levels: Vec::new(),
    })
    .collect()
}

/// Cache entries are scoped to the OAuth account they were fetched for, so
/// an account switch within the TTL can never serve the previous account's
/// catalog. Tokens without a decodable account id skip the cache entirely.
struct ModelListCache {
    entry: Mutex<Option<(String, Instant, Vec<CodexModel>)>>,
}

impl ModelListCache {
    const fn new() -> Self {
        Self {
            entry: Mutex::new(None),
        }
    }

    fn get_at(&self, account_id: Option<&str>, now: Instant) -> Option<Vec<CodexModel>> {
        let account_id = account_id?;
        let guard = self.entry.lock().ok()?;
        let (stored_for, stored_at, models) = guard.as_ref()?;
        (stored_for == account_id && now.duration_since(*stored_at) < CACHE_TTL)
            .then(|| models.clone())
    }

    fn put_at(&self, account_id: Option<&str>, models: &[CodexModel], now: Instant) {
        let Some(account_id) = account_id else {
            return;
        };
        if let Ok(mut guard) = self.entry.lock() {
            *guard = Some((account_id.to_string(), now, models.to_vec()));
        }
    }
}

static CACHE: ModelListCache = ModelListCache::new();

async fn fetch_remote(
    base_url: &str,
    token: &str,
    account_id: Option<&str>,
) -> AppResult<Vec<CodexModel>> {
    let client = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .build()
        .map_err(|e| AppError::Ai(e.to_string()))?;
    let url = format!(
        "{}/models?client_version={}",
        base_url.trim_end_matches('/'),
        env!("CARGO_PKG_VERSION"),
    );

    let mut request = client.get(&url).bearer_auth(token);
    if let Some(acct) = account_id {
        request = request.header("chatgpt-account-id", acct);
    }

    let response = request
        .send()
        .await
        .map_err(|e| AppError::Ai(e.to_string()))?;
    if !response.status().is_success() {
        return Err(AppError::Ai(format!(
            "models fetch error {}",
            response.status()
        )));
    }

    let body = response
        .text()
        .await
        .map_err(|e| AppError::Ai(e.to_string()))?;
    parse_models_response(&body)
}

/// Resolve credentials first, then serve the account-scoped cache, then
/// fetch. Any failure (no tokens, network, parse, or an empty visible list)
/// yields the bundled fallback, which is never cached so the next call —
/// e.g. right after OAuth connect — goes live again. The logged-out state
/// never consults the cache: no token always means the bundled list.
async fn resolve(secrets: &Secrets, base_url: &str, cache: &ModelListCache) -> CodexModelList {
    let (token, account_id) = match crate::ai::oauth::get_valid_token(secrets).await {
        Ok(credentials) => credentials,
        Err(e) => {
            log::warn!("codex models: no OAuth credentials, using bundled fallback: {e}");
            return CodexModelList {
                models: fallback_models(),
                from_fallback: true,
            };
        }
    };

    if let Some(models) = cache.get_at(account_id.as_deref(), Instant::now()) {
        return CodexModelList {
            models,
            from_fallback: false,
        };
    }

    match fetch_remote(base_url, &token, account_id.as_deref()).await {
        Ok(models) if !models.is_empty() => {
            cache.put_at(account_id.as_deref(), &models, Instant::now());
            CodexModelList {
                models,
                from_fallback: false,
            }
        }
        Ok(_) => {
            log::warn!("codex models: fetched list empty after filtering — using bundled fallback");
            CodexModelList {
                models: fallback_models(),
                from_fallback: true,
            }
        }
        Err(e) => {
            log::warn!("codex models: fetch failed, using bundled fallback: {e}");
            CodexModelList {
                models: fallback_models(),
                from_fallback: true,
            }
        }
    }
}

/// Entry point for the `list_codex_models` command.
pub async fn list_models(secrets: &Secrets) -> CodexModelList {
    resolve(secrets, CODEX_BASE_URL, &CACHE).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model(slug: &str) -> CodexModel {
        CodexModel {
            slug: slug.to_string(),
            display_name: slug.to_string(),
            description: String::new(),
            supported_reasoning_levels: Vec::new(),
        }
    }

    #[test]
    fn parse_live_catalog_shape() {
        // Regression fixture mirroring the real codex-cli 0.146.0 catalog
        // (~/.codex/models_cache.json): reasoning levels are objects with
        // effort + description, alongside extra fields Quill ignores.
        let body = r#"{
            "etag": "W/\"4d713bd0065c56756eb1545af1897f13\"",
            "models": [
                {
                    "slug": "gpt-5.6-sol",
                    "display_name": "GPT-5.6-Sol",
                    "description": "Latest frontier agentic coding model.",
                    "default_reasoning_level": "low",
                    "supported_reasoning_levels": [
                        {"effort": "low", "description": "Fast responses with lighter reasoning"},
                        {"effort": "medium", "description": "Balances speed and reasoning depth for everyday tasks"},
                        {"effort": "high", "description": "Greater reasoning depth for complex problems"},
                        {"effort": "xhigh", "description": "Extra high reasoning depth for complex problems"},
                        {"effort": "max", "description": "Maximum reasoning depth for the hardest problems"},
                        {"effort": "ultra", "description": "Maximum reasoning with automatic task delegation"}
                    ],
                    "shell_type": "shell_command",
                    "visibility": "list",
                    "supported_in_api": true,
                    "priority": 1,
                    "additional_speed_tiers": ["fast"],
                    "service_tiers": [
                        {"id": "priority", "name": "Fast", "description": "1.5x speed, increased usage"}
                    ],
                    "availability_nux": null,
                    "upgrade": null,
                    "base_instructions": "You are Codex, an agent based on GPT-5."
                }
            ]
        }"#;
        let models = parse_models_response(body).unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].slug, "gpt-5.6-sol");
        assert_eq!(models[0].display_name, "GPT-5.6-Sol");
        assert_eq!(models[0].description, "Latest frontier agentic coding model.");
        assert_eq!(
            models[0].supported_reasoning_levels,
            vec!["low", "medium", "high", "xhigh", "max", "ultra"]
        );
    }

    #[test]
    fn parse_accepts_bare_string_reasoning_levels() {
        let body = r#"{
            "models": [
                {"slug": "m", "supported_reasoning_levels": ["low", "high"]}
            ]
        }"#;
        let models = parse_models_response(body).unwrap();
        assert_eq!(models[0].supported_reasoning_levels, vec!["low", "high"]);
    }

    #[test]
    fn parse_tolerates_missing_optional_fields() {
        let body = r#"{"models": [{"slug": "gpt-5.3-codex"}]}"#;
        let models = parse_models_response(body).unwrap();
        assert_eq!(models.len(), 1);
        // display_name falls back to the slug so the picker never shows blank
        assert_eq!(models[0].display_name, "gpt-5.3-codex");
        assert_eq!(models[0].description, "");
        assert!(models[0].supported_reasoning_levels.is_empty());
    }

    #[test]
    fn parse_ignores_unknown_fields() {
        let body = r#"{"models": [{"slug": "m", "default_reasoning_level": "medium", "extra": 42}], "etag": "abc"}"#;
        let models = parse_models_response(body).unwrap();
        assert_eq!(models.len(), 1);
    }

    #[test]
    fn parse_rejects_malformed_body() {
        assert!(parse_models_response("not json").is_err());
        assert!(parse_models_response(r#"{"data": []}"#).is_err());
    }

    #[test]
    fn visibility_filter_drops_hidden_keeps_rest() {
        let body = r#"{
            "models": [
                {"slug": "shown", "visibility": "list"},
                {"slug": "hidden-model", "visibility": "hidden"},
                {"slug": "hide-model", "visibility": "hide"},
                {"slug": "no-visibility"},
                {"slug": "future-variant", "visibility": "experimental"}
            ]
        }"#;
        let slugs: Vec<String> = parse_models_response(body)
            .unwrap()
            .into_iter()
            .map(|m| m.slug)
            .collect();
        assert_eq!(slugs, vec!["shown", "no-visibility", "future-variant"]);
    }

    #[test]
    fn cache_hit_within_ttl() {
        let cache = ModelListCache::new();
        let now = Instant::now();
        cache.put_at(Some("acct"), &[model("a")], now);

        let hit = cache.get_at(Some("acct"), now + CACHE_TTL - Duration::from_secs(1));
        assert_eq!(hit, Some(vec![model("a")]));
    }

    #[test]
    fn cache_miss_after_ttl() {
        let cache = ModelListCache::new();
        let now = Instant::now();
        cache.put_at(Some("acct"), &[model("a")], now);

        assert_eq!(cache.get_at(Some("acct"), now + CACHE_TTL), None);
        assert_eq!(
            cache.get_at(Some("acct"), now + CACHE_TTL + Duration::from_secs(60)),
            None
        );
    }

    #[test]
    fn cache_empty_misses() {
        let cache = ModelListCache::new();
        assert_eq!(cache.get_at(Some("acct"), Instant::now()), None);
    }

    #[test]
    fn cache_scoped_to_account() {
        let cache = ModelListCache::new();
        let now = Instant::now();
        cache.put_at(Some("acct_a"), &[model("a")], now);

        assert_eq!(cache.get_at(Some("acct_b"), now), None);
        assert_eq!(cache.get_at(Some("acct_a"), now), Some(vec![model("a")]));
    }

    #[test]
    fn cache_skipped_without_account_identity() {
        let cache = ModelListCache::new();
        let now = Instant::now();

        // No identity → nothing stored, nothing served
        cache.put_at(None, &[model("a")], now);
        assert_eq!(cache.get_at(Some("acct"), now), None);

        cache.put_at(Some("acct"), &[model("a")], now);
        assert_eq!(cache.get_at(None, now), None);
    }

    #[test]
    fn fallback_contains_default_model() {
        let models = fallback_models();
        assert!(models.iter().any(|m| m.slug == "gpt-5.3-codex"));
        // Bundled entries carry no levels — the frontend uses the union
        assert!(models.iter().all(|m| m.supported_reasoning_levels.is_empty()));
    }

    fn save_test_tokens(secrets: &Secrets, account_id: &str) {
        crate::ai::oauth::save_tokens(
            secrets,
            &crate::ai::oauth::OAuthTokens {
                access_token: "test_token".to_string(),
                refresh_token: "rt".to_string(),
                expires_at: u64::MAX,
                account_id: Some(account_id.to_string()),
            },
        )
        .unwrap();
    }

    #[tokio::test]
    async fn resolve_falls_back_without_tokens_even_with_cached_entry() {
        let secrets = Secrets::init_in_memory().unwrap();
        let cache = ModelListCache::new();
        // A fresh entry from a previously connected account must not be
        // served in the logged-out state.
        cache.put_at(Some("acct"), &[model("cached")], Instant::now());

        let list = resolve(&secrets, CODEX_BASE_URL, &cache).await;
        assert!(list.from_fallback);
        assert_eq!(list.models, fallback_models());
    }

    #[tokio::test]
    async fn resolve_falls_back_on_fetch_error() {
        let secrets = Secrets::init_in_memory().unwrap();
        save_test_tokens(&secrets, "acct");
        let cache = ModelListCache::new();

        // Unroutable base URL → immediate connection failure → fallback
        let list = resolve(&secrets, "http://127.0.0.1:1", &cache).await;
        assert!(list.from_fallback);
        assert_eq!(list.models, fallback_models());
        // Fallback results are never cached
        assert_eq!(cache.get_at(Some("acct"), Instant::now()), None);
    }

    #[tokio::test]
    async fn resolve_serves_cached_list_without_fetching() {
        let secrets = Secrets::init_in_memory().unwrap();
        save_test_tokens(&secrets, "acct");
        let cache = ModelListCache::new();
        cache.put_at(Some("acct"), &[model("cached")], Instant::now());

        // The base URL is unroutable — a fetch attempt would fall back, so
        // getting the cached list proves the cache short-circuits the network.
        let list = resolve(&secrets, "http://127.0.0.1:1", &cache).await;
        assert!(!list.from_fallback);
        assert_eq!(list.models, vec![model("cached")]);
    }

    #[tokio::test]
    async fn resolve_ignores_cache_from_other_account() {
        let secrets = Secrets::init_in_memory().unwrap();
        let cache = ModelListCache::new();
        // Account A's catalog is cached, then the user switches to account B
        // within the TTL: B must fetch its own list, never see A's.
        cache.put_at(Some("acct_a"), &[model("a-only")], Instant::now());
        save_test_tokens(&secrets, "acct_b");

        let list = resolve(&secrets, "http://127.0.0.1:1", &cache).await;
        assert!(list.from_fallback, "B's fetch failed, so B gets the bundled fallback");
        assert!(!list.models.contains(&model("a-only")));
    }
}
