//! Deep link `spook://` do login pelo navegador (lógica pura + integração com o plugin).
//!
//! Só `spook://auth?code=<código>` é aceito. O código é de uso único (60 s) e opaco: o que vale é o formato
//! (base64url, 20 a 128 caracteres, a mesma regra de `apps/web/src/desktop/browser-login.ts`). Qualquer outra
//! URL, parâmetro extra relevante, host/caminho diferente ou código malformado é ignorado em silêncio: o deep
//! link nunca navega o webview nem executa nada, apenas entrega o código ao front via evento.

/// Evento enviado ao webview com o código já validado (payload: a string do código; ver `shell::deep_link_setup`).
pub const AUTH_CODE_EVENT: &str = "spook-auth-code";

const SCHEME_PREFIX: &str = "spook://";
const MIN_CODE_LEN: usize = 20;
const MAX_CODE_LEN: usize = 128;
/// Tamanho máximo da URL inteira que olhamos (descarta lixo grande antes de qualquer parsing).
const MAX_URL_LEN: usize = 512;

fn is_valid_code(code: &str) -> bool {
    (MIN_CODE_LEN..=MAX_CODE_LEN).contains(&code.len())
        && code
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Extrai o código de `spook://auth?code=...`; `None` para qualquer outra coisa.
pub fn auth_code(raw: &str) -> Option<String> {
    if raw.len() > MAX_URL_LEN || !raw.is_ascii() {
        return None;
    }
    let prefix = raw.get(..SCHEME_PREFIX.len())?;
    if !prefix.eq_ignore_ascii_case(SCHEME_PREFIX) {
        return None;
    }
    let rest = &raw[SCHEME_PREFIX.len()..];
    // O fragmento não é usado: descarta.
    let rest = rest.split('#').next().unwrap_or("");
    let (target, query) = rest.split_once('?')?;
    // O sistema pode normalizar `spook://auth?x` para `spook://auth/?x`.
    let target = target.strip_suffix('/').unwrap_or(target);
    if !target.eq_ignore_ascii_case("auth") {
        return None;
    }
    let mut found: Option<&str> = None;
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        if key == "code" {
            // `code` repetido é ambíguo: rejeita.
            if found.is_some() {
                return None;
            }
            found = Some(value);
        }
    }
    let code = found?;
    is_valid_code(code).then(|| code.to_string())
}

/// Primeiro código válido de uma lista de URLs.
pub fn first_auth_code<S: AsRef<str>>(urls: &[S]) -> Option<String> {
    urls.iter().find_map(|u| auth_code(u.as_ref()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const CODE: &str = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCde";

    #[test]
    fn accepts_only_spook_auth_with_a_well_formed_code() {
        assert_eq!(
            auth_code(&format!("spook://auth?code={CODE}")).as_deref(),
            Some(CODE)
        );
        // barra final normalizada pelo SO, esquema/host em caixa diferente, fragmento e outros parâmetros
        assert_eq!(
            auth_code(&format!("spook://auth/?code={CODE}")).as_deref(),
            Some(CODE)
        );
        assert_eq!(
            auth_code(&format!("SPOOK://AUTH?code={CODE}")).as_deref(),
            Some(CODE)
        );
        assert_eq!(
            auth_code(&format!("spook://auth?x=1&code={CODE}&y=2#frag")).as_deref(),
            Some(CODE)
        );
    }

    #[test]
    fn rejects_other_schemes_hosts_and_paths() {
        for url in [
            format!("https://auth?code={CODE}"),
            format!("http://spook.test/auth?code={CODE}"),
            format!("spook://outra?code={CODE}"),
            format!("spook://auth/extra?code={CODE}"),
            format!("spook://auth.evil.com?code={CODE}"),
            format!("spook://user@auth?code={CODE}"),
            format!("spook:auth?code={CODE}"),
            format!("spook:///auth?code={CODE}"),
            format!("file:///etc/passwd?code={CODE}"),
            format!("javascript:alert(1)//spook://auth?code={CODE}"),
            format!(" spook://auth?code={CODE}"),
        ] {
            assert_eq!(auth_code(&url), None, "{url}");
        }
    }

    #[test]
    fn rejects_missing_short_long_or_malformed_codes() {
        assert_eq!(auth_code("spook://auth"), None);
        assert_eq!(auth_code("spook://auth?"), None);
        assert_eq!(auth_code("spook://auth?code="), None);
        assert_eq!(auth_code("spook://auth?code=curto"), None);
        assert_eq!(auth_code("spook://auth?codex=".to_string().as_str()), None);
        let long = "a".repeat(MAX_CODE_LEN + 1);
        assert_eq!(auth_code(&format!("spook://auth?code={long}")), None);
        let max = "a".repeat(MAX_CODE_LEN);
        assert_eq!(
            auth_code(&format!("spook://auth?code={max}")).as_deref(),
            Some(max.as_str())
        );
        let min = "a".repeat(MIN_CODE_LEN);
        assert!(auth_code(&format!("spook://auth?code={min}")).is_some());
        let below = "a".repeat(MIN_CODE_LEN - 1);
        assert_eq!(auth_code(&format!("spook://auth?code={below}")), None);
        for bad in [
            "abcdefghijklmnopqrst+/",
            "abcdefghijklmnopqrst==",
            "abcdefghijklmnopqrst%41",
            "abcdefghijklmnopqrst abc",
            "abcdefghijklmnopqrst<script>",
            "abcdefghijklmnopqrstç",
            "abcdefghijklmnopqrst\u{0}",
        ] {
            assert_eq!(
                auth_code(&format!("spook://auth?code={bad}")),
                None,
                "{bad}"
            );
        }
    }

    #[test]
    fn rejects_repeated_code_and_oversized_urls() {
        assert_eq!(
            auth_code(&format!("spook://auth?code={CODE}&code={CODE}")),
            None
        );
        let junk = "x".repeat(MAX_URL_LEN);
        assert_eq!(
            auth_code(&format!("spook://auth?code={CODE}&{junk}=1")),
            None
        );
    }

    #[test]
    fn first_auth_code_skips_invalid_urls() {
        let urls = [
            "https://example.com".to_string(),
            "spook://auth?code=x".to_string(),
            format!("spook://auth?code={CODE}"),
        ];
        assert_eq!(first_auth_code(&urls).as_deref(), Some(CODE));
        assert_eq!(first_auth_code::<&str>(&[]), None);
    }
}
