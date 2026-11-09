//! Política de assinatura das telas de outras pessoas (assistir sob demanda), igual à da engine web: a tela
//! (vídeo e áudio) só é assinada enquanto a pessoa estiver na lista de "assistindo"; voz e câmera são sempre
//! assinadas. Lógica pura (sem LiveKit nem Tauri) para ser testada isoladamente.

use std::collections::HashSet;
use std::sync::Mutex;

/// Natureza de uma publicação remota, só o que importa para decidir se ela é assinada.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubKind {
    /// Vídeo da tela compartilhada.
    ScreenVideo,
    /// Áudio da tela compartilhada (`ScreenshareAudio`).
    ScreenAudio,
    /// Microfone, câmera e qualquer outra coisa: sempre assinados.
    Other,
}

impl SubKind {
    pub fn is_screen(self) -> bool {
        matches!(self, Self::ScreenVideo | Self::ScreenAudio)
    }
}

/// O que fazer com uma publicação para ela ficar como se quer.
/// `desired`: o pedido de assinatura enviado ao servidor; `subscribed`: a faixa já chegou.
/// `Some(x)` = chamar `set_subscribed(x)`; `None` = já está certo. Uma faixa que chegou "de carona"
/// (assinatura cancelada antes de ela chegar) conta como errada: precisa ser descartada.
pub fn decide(want: bool, desired: bool, subscribed: bool) -> Option<bool> {
    if desired != want || (!want && subscribed) {
        Some(want)
    } else {
        None
    }
}

/// Identidades cuja tela o usuário escolheu assistir. Vale por sala (vive dentro da sessão).
#[derive(Debug, Default)]
pub struct WatchSet {
    ids: Mutex<HashSet<String>>,
}

impl WatchSet {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashSet<String>> {
        self.ids.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Marca/desmarca. Devolve `true` se o conjunto mudou.
    pub fn set(&self, identity: &str, watching: bool) -> bool {
        let mut ids = self.lock();
        if watching {
            ids.insert(identity.to_string())
        } else {
            ids.remove(identity)
        }
    }

    pub fn contains(&self, identity: &str) -> bool {
        self.lock().contains(identity)
    }

    pub fn len(&self) -> usize {
        self.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.lock().is_empty()
    }

    pub fn clear(&self) {
        self.lock().clear();
    }

    /// Esta publicação deve estar assinada? Tela só com "assistir"; o resto sempre.
    pub fn wants(&self, kind: SubKind, identity: &str) -> bool {
        !kind.is_screen() || self.contains(identity)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn screens_are_not_wanted_until_watched() {
        let w = WatchSet::new();
        assert!(!w.wants(SubKind::ScreenVideo, "7"));
        assert!(!w.wants(SubKind::ScreenAudio, "7"));
        assert!(w.set("7", true));
        assert!(w.wants(SubKind::ScreenVideo, "7"));
        assert!(w.wants(SubKind::ScreenAudio, "7"));
        // outra pessoa continua sem assinatura
        assert!(!w.wants(SubKind::ScreenVideo, "8"));
    }

    #[test]
    fn voice_and_camera_are_always_wanted() {
        let w = WatchSet::new();
        assert!(w.wants(SubKind::Other, "7"));
        assert!(w.wants(SubKind::Other, ""));
    }

    #[test]
    fn set_reports_changes_and_is_idempotent() {
        let w = WatchSet::new();
        assert!(w.set("7", true));
        assert!(!w.set("7", true));
        assert_eq!(w.len(), 1);
        assert!(w.set("7", false));
        assert!(!w.set("7", false));
        assert!(w.is_empty());
        w.set("1", true);
        w.set("2", true);
        w.clear();
        assert!(w.is_empty());
        assert!(!w.contains("1"));
    }

    #[test]
    fn decide_subscribes_unsubscribes_and_drops_ghosts() {
        // quer e ainda não pediu
        assert_eq!(decide(true, false, false), Some(true));
        // quer e já pediu (a faixa chegando ou já chegou)
        assert_eq!(decide(true, true, false), None);
        assert_eq!(decide(true, true, true), None);
        // não quer, mas estava assinada
        assert_eq!(decide(false, true, true), Some(false));
        // não quer, pedido pendente (faixa ainda não chegou): cancela o pedido
        assert_eq!(decide(false, true, false), Some(false));
        // não quer e nada pedido
        assert_eq!(decide(false, false, false), None);
        // faixa "fantasma": chegou sem pedido (assistir e parar rápido)
        assert_eq!(decide(false, false, true), Some(false));
    }

    #[test]
    fn quick_watch_stop_watch_converges_to_the_last_choice() {
        // Simula assistir -> parar -> assistir: a cada passo o estado do SDK é reconciliado com o desejo.
        let w = WatchSet::new();
        let mut sdk = (false, false); // (desired, subscribed)
        fn apply(w: &WatchSet, sdk: &mut (bool, bool)) {
            if let Some(x) = decide(w.wants(SubKind::ScreenVideo, "7"), sdk.0, sdk.1) {
                sdk.0 = x;
                if !x {
                    sdk.1 = false;
                }
            }
        }
        w.set("7", true);
        apply(&w, &mut sdk);
        assert!(sdk.0);
        w.set("7", false);
        apply(&w, &mut sdk);
        assert_eq!(sdk, (false, false));
        // a faixa do primeiro pedido chega atrasada
        sdk.1 = true;
        apply(&w, &mut sdk);
        assert!(!sdk.1, "faixa fantasma descartada");
        w.set("7", true);
        apply(&w, &mut sdk);
        assert!(sdk.0);
    }
}
