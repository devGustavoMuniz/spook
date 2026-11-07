#!/bin/sh
# Instala (ou remove) o agendamento do backup para o usuário `spook`. Rode COMO `spook`, no VPS:
#   ssh <vps> "sudo -iu spook /srv/spook/prod/deploy/install-backup-timer.sh"            instala
#   ssh <vps> "sudo -iu spook /srv/spook/prod/deploy/install-backup-timer.sh --status"   mostra o estado
#   ssh <vps> "sudo -iu spook /srv/spook/prod/deploy/install-backup-timer.sh --uninstall"
# Usa `systemd --user` (o usuário já tem linger); se não houver systemd de usuário, cai para o crontab.
# Idempotente. Nunca roda pela chave de CI (o ci-entry.sh não o aceita).
set -eu

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$APP_DIR/deploy/systemd"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
MARK="# spook-backup (install-backup-timer.sh)"
XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export XDG_RUNTIME_DIR
UNITS="spook-backup.timer spook-backup-check.timer"
ALL_UNITS="spook-backup.service spook-backup.timer spook-backup-check.service spook-backup-check.timer"
MODE="${1:-install}"

have_user_systemd() { command -v systemctl > /dev/null 2>&1 && systemctl --user show-environment > /dev/null 2>&1; }

backup_dir_hint() {
  d="${BACKUP_DIR:-/srv/spook/backups}"
  if ! mkdir -p "$d" 2> /dev/null; then
    echo "AVISO: não consegui criar $d. Como administrador: sudo install -d -o spook -m 700 $d (ou defina BACKUP_DIR no .env)" >&2
  fi
}

case "$MODE" in
  install|--install)
    [ -x "$APP_DIR/deploy/backup.sh" ] || { echo "erro: $APP_DIR/deploy/backup.sh não existe ou não é executável" >&2; exit 1; }
    backup_dir_hint
    if have_user_systemd; then
      mkdir -p "$UNIT_DIR"
      for f in $ALL_UNITS; do
        sed "s|__APP_DIR__|$APP_DIR|g" "$SRC/$f" > "$UNIT_DIR/$f.tmp"
        mv "$UNIT_DIR/$f.tmp" "$UNIT_DIR/$f"
      done
      systemctl --user daemon-reload
      # shellcheck disable=SC2086
      systemctl --user enable --now $UNITS
      echo "Instalado via systemd --user. Verifique: systemctl --user list-timers 'spook-backup*'"
      if command -v loginctl > /dev/null 2>&1 && [ "$(loginctl show-user "$(id -un)" -p Linger --value 2> /dev/null || true)" != yes ]; then
        echo "AVISO: linger desativado; os timers só rodam com o usuário logado. Como administrador: sudo loginctl enable-linger $(id -un)" >&2
      fi
    else
      command -v crontab > /dev/null 2>&1 || { echo "erro: sem systemd --user e sem crontab" >&2; exit 1; }
      cur="$(crontab -l 2> /dev/null | grep -v -F "$MARK" || true)"
      {
        [ -z "$cur" ] || printf '%s\n' "$cur"
        # 04:00 (hora local do servidor, normalmente UTC) + jitter de até ~15 min; % é especial no cron, daí o \\%
        # shellcheck disable=SC2016  # $(( )) é do crontab, não deste shell
        printf '0 4 * * * sleep $(( $(date +\\%%s) \\%% 900 )); %s/deploy/backup.sh >> %s/backup-cron.log 2>&1 %s\n' "$APP_DIR" "$HOME" "$MARK"
        printf '0 8 * * 1 %s/deploy/backup-status.sh --verify >> %s/backup-cron.log 2>&1 %s\n' "$APP_DIR" "$HOME" "$MARK"
      } | crontab -
      echo "Instalado via crontab (sem systemd --user). Verifique: crontab -l"
    fi
    ;;
  --uninstall|uninstall)
    if have_user_systemd; then
      # shellcheck disable=SC2086
      systemctl --user disable --now $UNITS 2> /dev/null || true
      for f in $ALL_UNITS; do rm -f "${UNIT_DIR:?}/${f:?}"; done
      systemctl --user daemon-reload
      echo "Removido do systemd --user."
    fi
    if command -v crontab > /dev/null 2>&1 && crontab -l 2> /dev/null | grep -q -F "$MARK"; then
      crontab -l | grep -v -F "$MARK" | crontab - || true
      echo "Removido do crontab."
    fi
    ;;
  --status|status)
    if have_user_systemd; then systemctl --user list-timers 'spook-backup*' --all --no-pager || true; fi
    if command -v crontab > /dev/null 2>&1; then crontab -l 2> /dev/null | grep -F "$MARK" || true; fi
    "$APP_DIR/deploy/backup-status.sh" || true
    ;;
  *) echo "uso: install-backup-timer.sh [--status|--uninstall]" >&2; exit 2 ;;
esac
