#[cfg(target_os = "macos")]
use std::ptr::NonNull;
#[cfg(any(target_os = "macos", test))]
use std::{cell::RefCell, collections::HashMap};

#[cfg(target_os = "macos")]
use crate::error::AppError;
use crate::error::AppResult;
#[cfg(target_os = "macos")]
use block2::RcBlock;
#[cfg(target_os = "macos")]
use objc2_app_kit::{NSWindow, NSWindowButton, NSWindowDidResizeNotification, NSWindowStyleMask};
#[cfg(target_os = "macos")]
use objc2_foundation::{NSNotification, NSNotificationCenter};

#[cfg(any(target_os = "macos", test))]
const MAIN_TITLEBAR_HEIGHT: f64 = 44.0;
#[cfg(any(target_os = "macos", test))]
const READER_TITLEBAR_HEIGHT: f64 = 32.0;
#[cfg(any(target_os = "macos", test))]
const TRAFFIC_LIGHT_X: f64 = 16.0;

#[cfg(target_os = "macos")]
type ObserverCleanup = Box<dyn FnOnce()>;

// objc2 observer tokens are !Send. Both `with_webview` and Tauri's window
// lifecycle callback run on the macOS main thread, so the token stays there.
#[cfg(target_os = "macos")]
thread_local! {
    static TITLEBAR_RESIZE_OBSERVERS: RefCell<HashMap<String, ObserverCleanup>> =
        RefCell::new(HashMap::new());
}

#[cfg(any(target_os = "macos", test))]
thread_local! {
    static TITLEBAR_ZOOMS: RefCell<HashMap<String, f64>> = RefCell::new(HashMap::new());
}

#[cfg(any(target_os = "macos", test))]
fn set_titlebar_zoom(label: &str, zoom: f64) {
    TITLEBAR_ZOOMS.with(|zooms| {
        zooms.borrow_mut().insert(label.to_string(), zoom);
    });
}

#[cfg(any(target_os = "macos", test))]
fn titlebar_zoom(label: &str) -> Option<f64> {
    TITLEBAR_ZOOMS.with(|zooms| zooms.borrow().get(label).copied())
}

#[cfg(any(target_os = "macos", test))]
fn remove_titlebar_zoom(label: &str) {
    TITLEBAR_ZOOMS.with(|zooms| {
        zooms.borrow_mut().remove(label);
    });
}

#[cfg(any(target_os = "macos", test))]
fn scaled_titlebar_height(label: &str, zoom: f64, fullscreen: bool) -> Option<f64> {
    if fullscreen {
        return None;
    }
    let base_height = if label == "main" {
        MAIN_TITLEBAR_HEIGHT
    } else {
        READER_TITLEBAR_HEIGHT
    };
    Some(base_height * zoom)
}

#[cfg(any(target_os = "macos", test))]
fn traffic_light_x(index: usize, spacing: f64) -> f64 {
    TRAFFIC_LIGHT_X + index as f64 * spacing
}

#[cfg(any(target_os = "macos", test))]
fn traffic_light_y(titlebar_height: f64, button_height: f64) -> f64 {
    (titlebar_height - button_height) / 2.0
}

#[tauri::command]
pub fn window_set_titlebar_zoom(window: tauri::WebviewWindow, zoom: f64) -> AppResult<()> {
    #[cfg(target_os = "macos")]
    {
        let fullscreen = window
            .is_fullscreen()
            .map_err(|error| AppError::Other(error.to_string()))?;
        let label = window.label().to_string();

        window
            .with_webview(move |webview| {
                let ns_window: &NSWindow = unsafe { &*webview.ns_window().cast() };
                set_titlebar_zoom(&label, zoom);
                if !fullscreen {
                    apply_titlebar_frames(ns_window, &label, zoom);
                }
                install_titlebar_resize_observer(label, ns_window);
            })
            .map_err(|error| AppError::Other(error.to_string()))?;
    }

    #[cfg(not(target_os = "macos"))]
    let _ = (window, zoom);

    Ok(())
}

#[cfg(target_os = "macos")]
fn apply_titlebar_frames(ns_window: &NSWindow, label: &str, zoom: f64) {
    if ns_window
        .styleMask()
        .contains(NSWindowStyleMask::FullScreen)
    {
        return;
    }

    let Some(titlebar_height) = scaled_titlebar_height(label, zoom, false) else {
        return;
    };
    let Some(close) = ns_window.standardWindowButton(NSWindowButton::CloseButton) else {
        return;
    };
    let Some(minimize) = ns_window.standardWindowButton(NSWindowButton::MiniaturizeButton) else {
        return;
    };
    let Some(maximize) = ns_window.standardWindowButton(NSWindowButton::ZoomButton) else {
        return;
    };
    let Some(button_group) = (unsafe { close.superview() }) else {
        return;
    };
    let Some(titlebar_container) = (unsafe { button_group.superview() }) else {
        return;
    };

    let button_height = close.frame().size.height;
    let spacing = minimize.frame().origin.x - close.frame().origin.x;
    let mut titlebar_rect = titlebar_container.frame();
    titlebar_rect.size.height = titlebar_height;
    titlebar_rect.origin.y = ns_window.frame().size.height - titlebar_height;
    titlebar_container.setFrame(titlebar_rect);

    for (index, button) in [close, minimize, maximize].into_iter().enumerate() {
        let mut rect = button.frame();
        rect.origin.x = traffic_light_x(index, spacing);
        rect.origin.y = traffic_light_y(titlebar_height, button_height);
        button.setFrameOrigin(rect.origin);
    }
}

#[cfg(target_os = "macos")]
fn install_titlebar_resize_observer(label: String, ns_window: &NSWindow) {
    TITLEBAR_RESIZE_OBSERVERS.with(|observers| {
        let mut observers = observers.borrow_mut();
        if observers.contains_key(&label) {
            return;
        }

        let observed_label = label.clone();
        let block = RcBlock::new(move |notification: NonNull<NSNotification>| {
            let Some(zoom) = titlebar_zoom(&observed_label) else {
                return;
            };
            let Some(object) = (unsafe { notification.as_ref() }).object() else {
                return;
            };
            let ns_window = unsafe { &*std::ptr::from_ref(&*object).cast::<NSWindow>() };
            apply_titlebar_frames(ns_window, &observed_label, zoom);
        });
        let center = NSNotificationCenter::defaultCenter();
        let observer = unsafe {
            center.addObserverForName_object_queue_usingBlock(
                Some(NSWindowDidResizeNotification),
                Some(ns_window),
                None,
                &block,
            )
        };

        observers.insert(
            label,
            Box::new(move || {
                let center = NSNotificationCenter::defaultCenter();
                unsafe { center.removeObserver((*observer).as_ref()) };
            }),
        );
    });
}

#[cfg(target_os = "macos")]
pub(crate) fn uninstall_titlebar_resize_observer(label: &str) {
    let cleanup = TITLEBAR_RESIZE_OBSERVERS.with(|observers| observers.borrow_mut().remove(label));
    if let Some(cleanup) = cleanup {
        cleanup();
    }
    remove_titlebar_zoom(label);
}

#[cfg(test)]
mod tests {
    use super::{
        remove_titlebar_zoom, scaled_titlebar_height, set_titlebar_zoom, titlebar_zoom,
        traffic_light_x, traffic_light_y,
    };

    #[test]
    fn titlebar_geometry_tracks_app_zoom() {
        assert_eq!(scaled_titlebar_height("main", 0.8, false), Some(35.2));
        assert_eq!(scaled_titlebar_height("main", 1.0, false), Some(44.0));
        assert_eq!(scaled_titlebar_height("main", 1.5, false), Some(66.0));
        assert_eq!(
            scaled_titlebar_height("reader-book", 1.0, false),
            Some(32.0)
        );
        assert_eq!(
            scaled_titlebar_height("reader-book", 1.5, false),
            Some(48.0)
        );
        assert_eq!(traffic_light_x(0, 20.0), 16.0);
        assert_eq!(traffic_light_x(1, 20.0), 36.0);
        assert_eq!(traffic_light_x(2, 20.0), 56.0);
        assert_eq!(traffic_light_y(44.0, 14.0), 15.0);
    }

    #[test]
    fn fullscreen_skips_titlebar_repositioning() {
        assert_eq!(scaled_titlebar_height("main", 1.2, true), None);
        assert_eq!(scaled_titlebar_height("reader-book", 1.2, true), None);
    }

    #[test]
    fn titlebar_zoom_is_window_scoped_and_removed_on_cleanup() {
        set_titlebar_zoom("main", 0.8);
        set_titlebar_zoom("reader-book", 1.5);

        assert_eq!(titlebar_zoom("main"), Some(0.8));
        assert_eq!(titlebar_zoom("reader-book"), Some(1.5));

        remove_titlebar_zoom("reader-book");
        assert_eq!(titlebar_zoom("reader-book"), None);
        assert_eq!(titlebar_zoom("main"), Some(0.8));

        remove_titlebar_zoom("main");
    }
}
