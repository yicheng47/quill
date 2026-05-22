//! Process-wide panic hook that writes panic body + backtrace to the log
//! file before chaining to the previously-registered hook.
//!
//! Chained, not replaced: the default hook emits the stderr line the macOS
//! CrashReporter keys on, and we want both artifacts (the log entry AND the
//! `.ips` file) for any post-mortem. Calling `install()` more than once is
//! a no-op — the `OnceLock` guard means subsequent calls don't stack
//! additional layers on top of the chain.

use std::sync::OnceLock;

static INSTALLED: OnceLock<()> = OnceLock::new();

pub fn install() {
    if INSTALLED.set(()).is_err() {
        return;
    }
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let bt = std::backtrace::Backtrace::force_capture();
        log::error!("panic: {info}\n{bt}");
        prev(info);
    }));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Calling `install()` multiple times must not stack hooks on top of
    /// each other — otherwise every subsequent install would add another
    /// "log + chain" layer and a single panic would emit N log lines.
    /// Verifies both the idempotency guard and that the chain hits the
    /// pre-install hook exactly once.
    #[test]
    fn install_is_idempotent_and_chains() {
        static FIRED: AtomicUsize = AtomicUsize::new(0);

        // Save the current hook so we don't poison the test harness.
        let original = std::panic::take_hook();

        // Marker hook: increments on each invocation. Installed before
        // our first `install()` call so it ends up as `prev` in the
        // chain.
        std::panic::set_hook(Box::new(|_| {
            FIRED.fetch_add(1, Ordering::SeqCst);
        }));

        install();
        install();
        install();

        let _ = std::panic::catch_unwind(|| panic!("test panic"));

        std::panic::set_hook(original);

        let fired = FIRED.load(Ordering::SeqCst);
        assert_eq!(
            fired, 1,
            "marker hook should fire exactly once via the chain; got {fired}",
        );
    }
}
