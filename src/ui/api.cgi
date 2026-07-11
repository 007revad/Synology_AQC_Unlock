#!/bin/bash

PKG_NAME="AQC_Unlock"
PKG_ROOT="/var/packages/${PKG_NAME}"

#---------------------------------------------------------------------------
# Settings file location - mirrors drive_info's DSM6/7 fallback:
# DSM 7: var/ exists and is writable by the package (run-as: package)
# DSM 6: var/ doesn't exist; use etc/ instead
#---------------------------------------------------------------------------
if [[ -d "${PKG_ROOT}/var" ]]; then
    SETTINGS_CONF="${PKG_ROOT}/var/settings.conf"
else
    SETTINGS_CONF="${PKG_ROOT}/etc/settings.conf"
fi

#---------------------------------------------------------------------------
# QUERY_STRING is handed to a CGI script raw/percent-encoded by spec -
# decoding it is the script's own job, not something the web server does.
# Standard bash percent-decode idiom, nothing DSM-specific.
#---------------------------------------------------------------------------
urldecode() {
    local encoded="${1//+/ }"
    printf '%b' "${encoded//%/\\x}"
}

#---------------------------------------------------------------------------
# Parse action from QUERY_STRING
#---------------------------------------------------------------------------
_action=""
if [[ "${QUERY_STRING:-}" =~ (^|&)action=([^&]*) ]]; then
    _action="${BASH_REMATCH[2]}"
fi

#---------------------------------------------------------------------------
# action=get_status
# Reports whether AQC_Unlock is running in the degraded no-sudo state (see
# start-stop-status). While degraded, no interface has actually been
# injected/bridged, so the LAN reorder list has nothing real to show -
# aqc_unlock.js uses this to show setup instructions instead.
#
# Output: {"sudo_ok":true} or {"sudo_ok":false}
#---------------------------------------------------------------------------
if [[ "$_action" == "get_status" ]]; then
    printf 'Content-Type: application/json\r\n'
    printf 'Cache-Control: no-store\r\n'
    printf '\r\n'

    # Testing "sudo -n true" is wrong: the sudoers rule authorizes one exact
    # command path, not an arbitrary proxy like "true", so that check can
    # fail even when the real rule is correct. Test the actual authorized
    # command instead - "status" is read-only/harmless. sudo -n denies with
    # "a password is required" on stderr *before* ever running the target;
    # if we see that, it's a real auth failure regardless of exit code. Any
    # other outcome means sudo let the real command run, whatever it returned.
    _sudo_out=$(sudo -n /var/packages/AQC_Unlock/scripts/start-stop-status-root status 2>&1)

    if echo "$_sudo_out" | grep -q "a password is required"; then
        printf '{"sudo_ok":false}\n'
    else
        printf '{"sudo_ok":true}\n'
    fi
    exit 0
fi

#---------------------------------------------------------------------------
# action=get_lan_ports
# Enumerates real physical LAN ports (eth0, eth1, ...), maps each to DSM's
# "LAN N" label (confirmed mapping: ethN -> LAN(N+1)), and reports the
# device actually carrying traffic today - the OVS bridge (ovs_ethN) if
# AQC_Unlock has bridged that port, otherwise the physical interface itself.
#
# Ports are returned in the user's saved order (lan_order in settings.conf)
# if one exists; any port not present in a saved order (e.g. newly added
# hardware) is appended at the end in natural eth0..ethN order. If no order
# has ever been saved, natural order is used for all ports.
#
# Output: {"ports":[
#   {"id":"eth0","label":"LAN 1","route_dev":"eth0","connected":true,"ip":"192.168.20.202","speed_mbps":1000},
#   ...
# ]}
#
# "id" is always the physical interface name - that's the stable identity
# used for saving order, regardless of whether it's currently bridged.
# "route_dev" is what should be used later for any route/metric operations,
# since that's the device that actually appears in `ip route`.
#---------------------------------------------------------------------------
if [[ "$_action" == "get_lan_ports" ]]; then
    printf 'Content-Type: application/json\r\n'
    printf 'Cache-Control: no-store\r\n'
    printf '\r\n'

    _saved_order=$(synogetkeyvalue "$SETTINGS_CONF" lan_order 2>/dev/null || echo "")

    # Natural order: every real ethN device present on this system right now.
    _natural=()
    for _dev in /sys/class/net/eth*; do
        [[ -e "$_dev" ]] || continue
        _natural+=("$(basename "$_dev")")
    done
    # Numeric sort (eth0, eth1, ..., eth10) rather than lexical.
    IFS=$'\n' _natural=($(printf '%s\n' "${_natural[@]}" | sort -t h -k2 -n))
    unset IFS

    # Build final ordered id list: saved order first (only entries that still
    # exist), then any natural-order entries not already included.
    _ordered=()
    if [[ -n "$_saved_order" ]]; then
        IFS=',' read -ra _saved_ids <<< "$_saved_order"
        unset IFS
        for _id in "${_saved_ids[@]}"; do
            for _n in "${_natural[@]}"; do
                if [[ "$_n" == "$_id" ]]; then
                    _ordered+=("$_id")
                    break
                fi
            done
        done
    fi
    for _n in "${_natural[@]}"; do
        _already=0
        for _o in "${_ordered[@]}"; do
            [[ "$_o" == "$_n" ]] && _already=1 && break
        done
        [[ $_already -eq 0 ]] && _ordered+=("$_n")
    done

    printf '{"ports":['
    _first=1
    for _iface in "${_ordered[@]}"; do
        _num="${_iface#eth}"
        _label="LAN $((_num + 1))"

        _bridge="ovs_${_iface}"
        if [[ -d "/sys/class/net/${_bridge}" ]]; then
            _route_dev="$_bridge"
        else
            _route_dev="$_iface"
        fi

        _operstate=$(cat "/sys/class/net/${_route_dev}/operstate" 2>/dev/null || echo "unknown")
        if [[ "$_operstate" == "up" ]]; then
            _connected="true"
        else
            _connected="false"
        fi

        # Speed comes from the physical device, not route_dev - OVS bridges
        # don't reliably expose the underlying link's real speed via sysfs.
        # A down link has no meaningful speed regardless of what sentinel
        # value a given driver happens to report there (-1, 65535,
        # 4294967295 have all been observed), so only trust it when
        # actually connected.
        _speed=""
        if [[ "$_connected" == "true" ]]; then
            _speed=$(cat "/sys/class/net/${_iface}/speed" 2>/dev/null || echo "")
            if ! [[ "$_speed" =~ ^[0-9]+$ ]]; then
                _speed=""
            fi
        fi

        _ip=$(ip -4 -o addr show dev "$_route_dev" 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -n1)

        [[ $_first -eq 0 ]] && printf ','
        printf '{"id":"%s","label":"%s","route_dev":"%s","connected":%s,"ip":"%s","speed_mbps":%s}' \
            "$_iface" "$_label" "$_route_dev" "$_connected" "$_ip" "${_speed:-null}"
        _first=0
    done
    printf ']}\n'
    exit 0
fi

#---------------------------------------------------------------------------
# action=save_lan_order
# Params: order=eth0,eth2,eth4,eth1,eth3  (comma-separated physical iface ids)
# Only writes if the value actually changed. Returns {"ok":true,"changed":bool}
#---------------------------------------------------------------------------
if [[ "$_action" == "save_lan_order" ]]; then
    printf 'Content-Type: application/json\r\n'
    printf 'Cache-Control: no-store\r\n'
    printf '\r\n'

    _order=""
    if [[ "${QUERY_STRING:-}" =~ (^|&)order=([^&]*) ]]; then
        _order="$(urldecode "${BASH_REMATCH[2]}")"
    fi

    if [[ -z "$_order" ]]; then
        printf '{"ok":false,"error":"missing order parameter"}\n'
        exit 0
    fi

    _cur=$(synogetkeyvalue "$SETTINGS_CONF" lan_order 2>/dev/null || echo "")
    if [[ "$_cur" == "$_order" ]]; then
        printf '{"ok":true,"changed":false}\n'
        exit 0
    fi

    synosetkeyvalue "$SETTINGS_CONF" lan_order "$_order"
    printf '{"ok":true,"changed":true}\n'
    exit 0
fi

#---------------------------------------------------------------------------
# Unknown or missing action
#---------------------------------------------------------------------------
printf 'Content-Type: application/json\r\n'
printf '\r\n'
printf '{"ok":false,"error":"unknown action"}\n'
exit 0
