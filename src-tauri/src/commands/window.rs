#[cfg(target_os = "macos")]
use crate::error::AppError;
use crate::error::AppResult;

#[cfg(any(target_os = "macos", test))]
const MAIN_TITLEBAR_HEIGHT: f64 = 44.0;
#[cfg(any(target_os = "macos", test))]
const READER_TITLEBAR_HEIGHT: f64 = 32.0;
#[cfg(any(target_os = "macos", test))]
const TRAFFIC_LIGHT_X: f64 = 16.0;

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
        let Some(titlebar_height) = scaled_titlebar_height(window.label(), zoom, fullscreen) else {
            return Ok(());
        };

        window
            .with_webview(move |webview| {
                use objc2_app_kit::{NSWindow, NSWindowButton};

                let ns_window: &NSWindow = unsafe { &*webview.ns_window().cast() };
                let Some(close) = ns_window.standardWindowButton(NSWindowButton::CloseButton)
                else {
                    return;
                };
                let Some(minimize) =
                    ns_window.standardWindowButton(NSWindowButton::MiniaturizeButton)
                else {
                    return;
                };
                let Some(maximize) = ns_window.standardWindowButton(NSWindowButton::ZoomButton)
                else {
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
            })
            .map_err(|error| AppError::Other(error.to_string()))?;
    }

    #[cfg(not(target_os = "macos"))]
    let _ = (window, zoom);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{scaled_titlebar_height, traffic_light_x, traffic_light_y};

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
}
