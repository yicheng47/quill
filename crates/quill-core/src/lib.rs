pub mod ai;
pub mod commands;
pub mod db;
pub mod dispatch;
pub mod epub;
pub mod error;
pub mod host;
pub mod icloud;
pub mod logging;
pub mod mcp;
pub mod panic_hook;
pub mod paths;
pub mod pdfium;
pub mod secrets;
pub mod sync;

pub use dispatch::{dispatch, CORE_COMMAND_NAMES};
pub use host::{boot, BootConfig, Core, ShellHost};
pub use mcp::stdio::mcp_stdio_main;
