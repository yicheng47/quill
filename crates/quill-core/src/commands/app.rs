use crate::error::AppResult;
use crate::host::Core;

/// Reveal the per-user app log directory in the OS file manager.
pub fn reveal_logs(core: &Core) -> AppResult<()> {
    core.host.reveal_path(&core.log_dir)
}
