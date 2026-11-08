#!/usr/bin/env bash
# Install the Paperclip R2 backup as a systemd user unit for the current user.
# Enables the timer but does NOT start it. Review the env file first.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bin_dir="$HOME/.local/share/paperclip-r2-backup"
unit_dir="$HOME/.config/systemd/user"
conf_dir="$HOME/.config/paperclip-r2-backup"

install -d -m 0755 "$bin_dir" "$unit_dir"
install -d -m 0700 "$conf_dir"
install -m 0755 "$here/paperclip_r2_backup.py" "$bin_dir/paperclip_r2_backup.py"
install -m 0644 "$here/database_snapshots.py" "$bin_dir/database_snapshots.py"
install -m 0644 "$here/systemd/paperclip-r2-backup.service" "$unit_dir/"
install -m 0644 "$here/systemd/paperclip-r2-backup.timer" "$unit_dir/"

if [ ! -e "$conf_dir/env" ]; then
  install -m 0600 "$here/env.example" "$conf_dir/env"
  echo "created $conf_dir/env from env.example: fill it in"
fi
chmod 0600 "$conf_dir/env"

systemctl --user daemon-reload
systemctl --user enable paperclip-r2-backup.timer
echo "timer enabled, not started. After editing the env file:"
echo "  python3 $bin_dir/paperclip_r2_backup.py --dry-run   (with the env loaded)"
echo "  systemctl --user start paperclip-r2-backup.timer"
echo "Run the timer while logged out with: loginctl enable-linger \$USER"
