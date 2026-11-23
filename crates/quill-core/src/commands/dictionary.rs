use std::path::PathBuf;

use crate::dictionary::{DictionaryConfigItem, DictionaryDescriptor, LookupDictionaryResult};
use crate::error::AppResult;
use crate::host::Core;

pub fn lookup_dictionary(
    core: &Core,
    term: String,
    lang_hint: Option<String>,
) -> AppResult<LookupDictionaryResult> {
    core.dictionary
        .lookup_dictionary(&core.db, &term, lang_hint.as_deref())
}

pub fn list_dictionaries(core: &Core) -> AppResult<Vec<DictionaryDescriptor>> {
    core.dictionary.list_dictionaries(&core.db)
}

pub fn import_dictionary(core: &Core, path: String) -> AppResult<DictionaryDescriptor> {
    let desc = core
        .dictionary
        .import_dictionary(&core.db, &PathBuf::from(path))?;
    core.host.emit(
        "settings-changed",
        serde_json::json!({ "keys": ["dictionaries_config"] }),
    );
    Ok(desc)
}

pub fn update_dictionaries_config(
    core: &Core,
    items: Vec<DictionaryConfigItem>,
) -> AppResult<Vec<DictionaryDescriptor>> {
    let next = core
        .dictionary
        .update_dictionaries_config(&core.db, items)?;
    core.host.emit(
        "settings-changed",
        serde_json::json!({ "keys": ["dictionaries_config"] }),
    );
    Ok(next)
}

pub fn remove_dictionary(core: &Core, id: String) -> AppResult<Vec<DictionaryDescriptor>> {
    let next = core.dictionary.remove_dictionary(&core.db, &id)?;
    core.host.emit(
        "settings-changed",
        serde_json::json!({ "keys": ["dictionaries_config"] }),
    );
    Ok(next)
}
