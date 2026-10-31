//! Navegação do webview: o app NUNCA navega para fora. Links externos abrem no navegador do sistema.

use tauri::Url;

/// A URL é do próprio app (protocolo do Tauri) e pode carregar no webview?
/// `dev_origin` é a origem do Vite (só em desenvolvimento).
pub fn is_internal(url: &Url, dev_origin: Option<&str>) -> bool {
    match url.scheme() {
        // macOS/Linux servem o app em tauri://localhost.
        "tauri" => url.host_str() == Some("localhost"),
        "about" => url.as_str() == "about:blank",
        // Windows (e Android) servem em http(s)://tauri.localhost.
        "http" | "https" => {
            url.host_str() == Some("tauri.localhost")
                || dev_origin.is_some_and(|o| url.origin().ascii_serialization() == o)
        }
        _ => false,
    }
}

/// Só esquemas inofensivos vão para o navegador/cliente de e-mail do sistema.
pub fn is_openable_externally(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https" | "mailto")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn app_origins_are_internal() {
        assert!(is_internal(&u("tauri://localhost/channels/1"), None));
        assert!(is_internal(&u("http://tauri.localhost/"), None));
        assert!(is_internal(&u("about:blank"), None));
    }

    #[test]
    fn external_sites_are_not_internal() {
        assert!(!is_internal(&u("https://example.com/"), None));
        assert!(!is_internal(&u("https://tauri.localhost.evil.com/"), None));
        assert!(!is_internal(&u("tauri://evil/"), None));
        assert!(!is_internal(&u("file:///etc/passwd"), None));
        assert!(!is_internal(&u("javascript:alert(1)"), None));
    }

    #[test]
    fn vite_origin_only_counts_when_given() {
        let url = u("http://localhost:5180/channels/1");
        assert!(!is_internal(&url, None));
        assert!(is_internal(&url, Some("http://localhost:5180")));
        assert!(!is_internal(
            &u("http://localhost:9999/"),
            Some("http://localhost:5180")
        ));
    }

    #[test]
    fn only_safe_schemes_open_externally() {
        assert!(is_openable_externally(&u("https://example.com")));
        assert!(is_openable_externally(&u("mailto:a@b.c")));
        assert!(!is_openable_externally(&u("file:///etc/passwd")));
        assert!(!is_openable_externally(&u("javascript:alert(1)")));
    }
}
