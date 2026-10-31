#!/bin/sh
# Starts the desktop session agent-desktop needs: a display, a session bus,
# the accessibility bus, and a window manager. Then waits.
set -e
mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"
Xvfb "$DISPLAY" -screen 0 1280x860x24 -nolisten tcp &
for i in $(seq 1 50); do [ -e "/tmp/.X11-unix/X${DISPLAY#:}" ] && break; sleep 0.1; done
dbus-daemon --session --address="$DBUS_SESSION_BUS_ADDRESS" --fork --nopidfile
/usr/libexec/at-spi-bus-launcher --launch-immediately &
openbox &
echo "momo-desktop ready"
exec sleep infinity
