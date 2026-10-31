//! Armazenamento do token de sessão do desktop.
//!
//! O token vai para o chaveiro do SO (serviço "Spook"). Se o chaveiro não estiver disponível (por
//! exemplo, Linux sem Secret Service), o cofre cai para a MEMÓRIA, com aviso à interface
//! (`persistent: false`): o usuário precisará entrar de novo ao reabrir o app. O token nunca é gravado
//! em arquivo claro.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::Serialize;

pub const SERVICE: &str = "Spook";
pub const ACCOUNT: &str = "session-token";

/// Armazenamento persistente (o chaveiro real, ou um dublê nos testes).
pub trait TokenStore: Send + Sync {
    fn get(&self) -> Result<Option<String>, String>;
    fn set(&self, token: &str) -> Result<(), String>;
    /// Remover um token que não existe não é erro.
    fn clear(&self) -> Result<(), String>;
}

/// Chaveiro do sistema operacional.
pub struct KeyringStore;

impl KeyringStore {
    fn entry() -> Result<keyring::Entry, String> {
        keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())
    }
}

impl TokenStore for KeyringStore {
    fn get(&self) -> Result<Option<String>, String> {
        match Self::entry()?.get_password() {
            Ok(t) => Ok(Some(t)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    fn set(&self, token: &str) -> Result<(), String> {
        Self::entry()?
            .set_password(token)
            .map_err(|e| e.to_string())
    }

    fn clear(&self) -> Result<(), String> {
        match Self::entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

/// Resposta dos comandos `auth_get_token` e `auth_set_token`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TokenState {
    pub token: Option<String>,
    /// `false` = o token só existe na memória (chaveiro indisponível): some ao fechar o app.
    pub persistent: bool,
}

pub struct TokenVault {
    store: Box<dyn TokenStore>,
    memory: Mutex<Option<String>>,
    degraded: AtomicBool,
}

impl TokenVault {
    pub fn new(store: Box<dyn TokenStore>) -> Self {
        Self {
            store,
            memory: Mutex::new(None),
            degraded: AtomicBool::new(false),
        }
    }

    fn memory(&self) -> std::sync::MutexGuard<'_, Option<String>> {
        self.memory.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn degrade(&self) {
        self.degraded.store(true, Ordering::SeqCst);
    }

    fn is_degraded(&self) -> bool {
        self.degraded.load(Ordering::SeqCst)
    }

    pub fn get(&self) -> TokenState {
        if !self.is_degraded() {
            match self.store.get() {
                Ok(token) => {
                    return TokenState {
                        token,
                        persistent: true,
                    }
                }
                Err(_) => self.degrade(),
            }
        }
        TokenState {
            token: self.memory().clone(),
            persistent: false,
        }
    }

    pub fn set(&self, token: &str) -> TokenState {
        if !self.is_degraded() {
            match self.store.set(token) {
                Ok(()) => {
                    *self.memory() = None;
                    return TokenState {
                        token: Some(token.to_owned()),
                        persistent: true,
                    };
                }
                Err(_) => self.degrade(),
            }
        }
        *self.memory() = Some(token.to_owned());
        TokenState {
            token: Some(token.to_owned()),
            persistent: false,
        }
    }

    /// Apaga o token de onde estiver. Falha do chaveiro ao apagar é reportada (o logout não deve
    /// fingir que apagou), mas a cópia em memória sempre some.
    pub fn clear(&self) -> Result<(), String> {
        *self.memory() = None;
        if self.is_degraded() {
            return Ok(());
        }
        self.store.clear()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[derive(Default)]
    struct Fake {
        value: Mutex<Option<String>>,
        broken: AtomicBool,
        clear_calls: Mutex<u32>,
    }

    impl Fake {
        fn check(&self) -> Result<(), String> {
            if self.broken.load(Ordering::SeqCst) {
                Err("Secret Service indisponível".into())
            } else {
                Ok(())
            }
        }
    }

    impl TokenStore for Arc<Fake> {
        fn get(&self) -> Result<Option<String>, String> {
            self.check()?;
            Ok(self.value.lock().unwrap().clone())
        }
        fn set(&self, token: &str) -> Result<(), String> {
            self.check()?;
            *self.value.lock().unwrap() = Some(token.to_owned());
            Ok(())
        }
        fn clear(&self) -> Result<(), String> {
            *self.clear_calls.lock().unwrap() += 1;
            self.check()?;
            *self.value.lock().unwrap() = None;
            Ok(())
        }
    }

    fn vault(fake: &Arc<Fake>) -> TokenVault {
        TokenVault::new(Box::new(fake.clone()))
    }

    #[test]
    fn empty_keyring_returns_no_token_but_persistent() {
        let v = vault(&Arc::new(Fake::default()));
        assert_eq!(
            v.get(),
            TokenState {
                token: None,
                persistent: true
            }
        );
    }

    #[test]
    fn set_get_clear_roundtrip_uses_the_keyring() {
        let fake = Arc::new(Fake::default());
        let v = vault(&fake);
        let st = v.set("abc");
        assert!(st.persistent);
        assert_eq!(fake.value.lock().unwrap().as_deref(), Some("abc"));
        assert_eq!(v.get().token.as_deref(), Some("abc"));
        v.clear().unwrap();
        assert_eq!(v.get().token, None);
        assert_eq!(*fake.value.lock().unwrap(), None);
    }

    #[test]
    fn token_survives_a_new_vault_over_the_same_keyring() {
        let fake = Arc::new(Fake::default());
        vault(&fake).set("persistido");
        assert_eq!(vault(&fake).get().token.as_deref(), Some("persistido"));
    }

    #[test]
    fn unavailable_keyring_falls_back_to_memory_with_warning() {
        let fake = Arc::new(Fake::default());
        fake.broken.store(true, Ordering::SeqCst);
        let v = vault(&fake);
        let st = v.set("so-memoria");
        assert_eq!(
            st,
            TokenState {
                token: Some("so-memoria".into()),
                persistent: false
            }
        );
        assert_eq!(
            v.get(),
            TokenState {
                token: Some("so-memoria".into()),
                persistent: false
            }
        );
        // Nada foi gravado no armazenamento persistente.
        assert_eq!(*fake.value.lock().unwrap(), None);
    }

    #[test]
    fn read_failure_at_startup_degrades_to_memory_without_token() {
        let fake = Arc::new(Fake::default());
        fake.broken.store(true, Ordering::SeqCst);
        let v = vault(&fake);
        assert_eq!(
            v.get(),
            TokenState {
                token: None,
                persistent: false
            }
        );
        // Mesmo que o chaveiro volte, a sessão continua em memória (comportamento previsível).
        fake.broken.store(false, Ordering::SeqCst);
        assert!(!v.set("x").persistent);
    }

    #[test]
    fn clear_wipes_memory_and_reports_keyring_failure() {
        let fake = Arc::new(Fake::default());
        let v = vault(&fake);
        v.set("abc");
        fake.broken.store(true, Ordering::SeqCst);
        assert!(v.clear().is_err());
        // Em modo degradado (memória) o clear funciona e não toca mais o chaveiro.
        let v2 = vault(&fake);
        v2.set("mem");
        assert!(v2.clear().is_ok());
        assert_eq!(v2.get().token, None);
        assert_eq!(*fake.clear_calls.lock().unwrap(), 1);
    }

    #[test]
    fn set_after_working_keyring_drops_stale_memory_copy() {
        let fake = Arc::new(Fake::default());
        let v = vault(&fake);
        v.set("novo");
        assert!(v.memory().is_none());
    }
}
