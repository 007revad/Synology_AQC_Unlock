Ext.namespace("SYNO.SDS.AQC_Unlock");

// The popup runs as an AppWindow embedded in the DSM desktop page - the
// browser's location never actually navigates to this package's own
// directory, so relative "api.cgi" URLs resolve against the desktop page
// instead and 404/500. Must use the package's real webman path.
var AQC_API_BASE = "/webman/3rdparty/AQC_Unlock/api.cgi";

// Maps raw Mbps to the label convention actually used for these link
// speeds (2.5G/5G are never written as 2500M/5000M in the wild) - falls
// back to a generic "<n>M"/"<n>G" for anything not in the common set.
function formatSpeed(mbps) {
    if (!mbps || mbps <= 0) {
        return "";
    }
    var known = {
        10: "10M", 100: "100M",
        1000: "1G", 2500: "2.5G", 5000: "5G", 10000: "10G", 25000: "25G"
    };
    if (known[mbps]) {
        return known[mbps];
    }
    if (mbps >= 1000) {
        var gbps = mbps / 1000;
        return (gbps % 1 === 0 ? gbps : gbps.toFixed(1)) + "G";
    }
    return mbps + "M";
}

Ext.define("SYNO.SDS._ThirdParty.App.AQC_Unlock", {
    extend: "SYNO.SDS.AppInstance",
    appWindowName: "SYNO.SDS.AQC_Unlock.MainWindow",
    constructor: function() {
        this.callParent(arguments);
    }
});
Ext.define("SYNO.SDS.AQC_Unlock.MainWindow", {
    extend: "SYNO.SDS.AppWindow",
    constructor: function(a) {
        this.appInstance = a.appInstance;
        SYNO.SDS.AQC_Unlock.MainWindow.superclass.constructor.call(this, Ext.apply({
            layout: "fit",
            resizable: false,
            cls: "syno-app-win",
            maximizable: false,
            minimizable: true,
            showHelp: false,
            width: 600,
            height: 462,
            html: SYNO.SDS.AQC_Unlock.MainWindow.prototype.bodyHtml,
            listeners: {
                afterrender: this.onAfterRender,
                scope: this
            }
        }, a));
    },

    // Static-ish body markup. IDs are scoped with an "aqc-" prefix to avoid
    // clashing with anything else DSM has in the DOM.
    bodyHtml:
        '<div style="font-family:Arial,sans-serif;font-size:13px;color:#333;height:100%;display:flex;flex-direction:column;box-sizing:border-box;padding:20px;">' +
            '<div id="aqc-intro">' +
                '<p style="margin:0 0 14px 0;">Set your preferred LAN port order for DSM to connect to other devices.</p>' +
                '<p style="margin:0 0 14px 0;color:#777;font-size:12px;">Drag to reorder. The top port is preferred when a client can be reached on more than one port.</p>' +
            '</div>' +
            '<div id="aqc-lan-list" style="flex:1;overflow-y:auto;border:1px solid #ddd;border-radius:4px;background:#fafafa;"></div>' +
            '<div id="aqc-lan-status" style="min-height:18px;margin-top:8px;font-size:12px;color:#c00;"></div>' +
            '<div id="aqc-button-row" style="margin-top:14px;text-align:right;">' +
                '<button id="aqc-btn-cancel" type="button" style="min-width:80px;padding:6px 14px;margin-right:8px;border:1px solid #ccc;border-radius:3px;background:#fff;cursor:pointer;">Cancel</button>' +
                '<button id="aqc-btn-save" type="button" style="min-width:80px;padding:6px 14px;border:1px solid #2b6cb0;border-radius:3px;background:#2b6cb0;color:#fff;cursor:pointer;">Save</button>' +
            '</div>' +
        '</div>',

    onAfterRender: function() {
        this.listEl = document.getElementById("aqc-lan-list");
        this.statusEl = document.getElementById("aqc-lan-status");

        var cancelBtn = document.getElementById("aqc-btn-cancel");
        var saveBtn = document.getElementById("aqc-btn-save");

        cancelBtn.addEventListener("click", this.onCancel.createDelegate(this));
        saveBtn.addEventListener("click", this.onSave.createDelegate(this));

        this.checkStatus();
    },

    // Checked first, before the LAN list: while sudoers isn't set up, no
    // interface has actually been injected/bridged, so the reorder list
    // would just be empty/misleading. Shows real setup instructions instead -
    // this window isn't subject to DSM's own popup copy/link restriction,
    // so an actual clickable, selectable link works fine here.
    checkStatus: function() {
        this.listEl.innerHTML = '<div style="padding:14px;color:#888;">Loading...</div>';

        var self = this;
        var xhr = new XMLHttpRequest();
        xhr.open("GET", AQC_API_BASE + "?action=get_status&_ts=" + Date.now(), true);
        xhr.onreadystatechange = function() {
            if (xhr.readyState !== 4) {
                return;
            }
            var sudoOk = true; // fail open - don't block the real UI on a status-check hiccup
            if (xhr.status === 200) {
                try {
                    var data = JSON.parse(xhr.responseText);
                    if (data && data.sudo_ok === false) {
                        sudoOk = false;
                    }
                } catch (e) {
                    // leave sudoOk = true, fall through to the normal list
                }
            }
            if (sudoOk) {
                self.loadInterfaces();
            } else {
                self.showSudoInstructions();
            }
        };
        xhr.onerror = function() {
            self.loadInterfaces();
        };
        xhr.send();
    },

    showSudoInstructions: function() {
        var setupUrl = "https://github.com/007revad/Synology_AQC_Unlock/blob/main/set_package_permissions.md";

        var introEl = document.getElementById("aqc-intro");
        if (introEl) {
            introEl.style.display = "none";
        }
        var buttonRowEl = document.getElementById("aqc-button-row");
        if (buttonRowEl) {
            buttonRowEl.style.display = "none";
        }

        this.statusEl.textContent = "";
        this.listEl.innerHTML =
            '<div style="padding:16px;">' +
                '<p style="margin:0 0 12px 0;color:#c00;font-weight:bold;">Setup needed</p>' +
                '<p style="margin:0 0 12px 0;">' +
                    'AQC Unlock is running, but the sudoers permission it needs hasn\u2019t been set up yet, ' +
                    'so no network card has been unlocked.' +
                '</p>' +
                '<p style="margin:0 0 12px 0;">Run this over SSH as an administrator:</p>' +
                '<pre style="background:#f5f5f5;border:1px solid #ddd;border-radius:4px;padding:10px;' +
                    'font-size:12px;white-space:pre-wrap;word-break:break-all;user-select:text;">' +
                    'echo "AQC_Unlock ALL=(root) NOPASSWD: /var/packages/AQC_Unlock/scripts/start-stop-status-root" | sudo tee /etc/sudoers.d/AQC_Unlock\n' +
                    'sudo chmod 440 /etc/sudoers.d/AQC_Unlock' +
                '</pre>' +
                '<p style="margin:12px 0;">Then restart AQC Unlock in Package Center.</p>' +
                '<p style="margin:0 0 12px 0;">Full instructions: ' +
                    '<a href="' + setupUrl + '" target="_blank" rel="noopener">' + setupUrl + '</a>' +
                '</p>' +
                '<button id="aqc-btn-recheck" type="button" style="padding:6px 14px;border:1px solid #ccc;' +
                    'border-radius:3px;background:#fff;cursor:pointer;">Check again</button>' +
            '</div>';

        var self = this;
        document.getElementById("aqc-btn-recheck").addEventListener("click", function() {
            self.checkStatus();
        });
    },

    // Fetches the real port list + saved order from api.cgi. Falls back to
    // an empty list with a visible error rather than silently showing
    // nothing if the request fails.
    loadInterfaces: function() {
        var introEl = document.getElementById("aqc-intro");
        if (introEl) {
            introEl.style.display = "";
        }
        var buttonRowEl = document.getElementById("aqc-button-row");
        if (buttonRowEl) {
            buttonRowEl.style.display = "";
        }

        this.listEl.innerHTML = '<div style="padding:14px;color:#888;">Loading...</div>';
        this.statusEl.textContent = "";

        var self = this;
        var xhr = new XMLHttpRequest();
        xhr.open("GET", AQC_API_BASE + "?action=get_lan_ports&_ts=" + Date.now(), true);
        xhr.onreadystatechange = function() {
            if (xhr.readyState !== 4) {
                return;
            }
            if (xhr.status !== 200) {
                self.showLoadError("HTTP " + xhr.status);
                return;
            }
            var data;
            try {
                data = JSON.parse(xhr.responseText);
            } catch (e) {
                self.showLoadError("Invalid response from api.cgi");
                return;
            }
            var ports = (data && Array.isArray(data.ports)) ? data.ports : [];
            if (ports.length === 0) {
                self.showLoadError("No LAN ports reported");
                return;
            }
            self.originalOrder = ports.map(function(p) { return p.id; });
            self.renderList(ports);
        };
        xhr.onerror = function() {
            self.showLoadError("Could not reach api.cgi");
        };
        xhr.send();
    },

    showLoadError: function(message) {
        this.listEl.innerHTML =
            '<div style="padding:14px;color:#c00;">' + message + '</div>';
    },

    renderList: function(ports) {
        this.listEl.innerHTML = "";
        var self = this;

        ports.forEach(function(port) {
            var item = document.createElement("div");
            item.className = "aqc-lan-item";
            item.setAttribute("draggable", "true");
            item.dataset.portId = port.id;
            item.style.cssText =
                "display:flex;align-items:center;padding:10px 12px;" +
                "border-bottom:1px solid #e5e5e5;background:#fff;cursor:grab;user-select:none;";

            var handle = document.createElement("span");
            handle.textContent = "\u2261"; // ≡ drag handle glyph
            handle.style.cssText = "margin-right:10px;color:#999;font-size:16px;line-height:1;";

            var label = document.createElement("span");
            label.style.flex = "1";

            var title = document.createElement("div");
            var speedLabel = formatSpeed(port.speed_mbps);
            title.textContent = port.label + "  (" + port.id + ")" + (speedLabel ? "  " + speedLabel : "");

            var detail = document.createElement("div");
            detail.style.cssText = "font-size:11px;color:#999;margin-top:2px;";
            var bits = [];
            bits.push(port.connected ? "Connected" : "Disconnected");
            if (port.ip) {
                bits.push(port.ip);
            }
            if (port.route_dev && port.route_dev !== port.id) {
                bits.push("bridged as " + port.route_dev);
            }
            detail.textContent = bits.join(" \u00b7 ");

            label.appendChild(title);
            label.appendChild(detail);

            item.appendChild(handle);
            item.appendChild(label);
            self.listEl.appendChild(item);

            item.addEventListener("dragstart", function(e) {
                item.style.opacity = "0.4";
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", port.id);
            });

            item.addEventListener("dragend", function() {
                item.style.opacity = "1";
            });

            item.addEventListener("dragover", function(e) {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";

                var dragging = self.listEl.querySelector('[style*="opacity: 0.4"]');
                if (!dragging || dragging === item) {
                    return;
                }

                var rect = item.getBoundingClientRect();
                var before = (e.clientY - rect.top) < (rect.height / 2);
                self.listEl.insertBefore(dragging, before ? item : item.nextSibling);
            });
        });
    },

    getCurrentOrder: function() {
        var items = this.listEl.querySelectorAll(".aqc-lan-item");
        var order = [];
        items.forEach(function(item) {
            order.push(item.dataset.portId);
        });
        return order;
    },

    // Discards any reordering and closes immediately - no need to restore
    // the list first since the window is going away either way.
    onCancel: function() {
        this.close();
    },

    // Only hits api.cgi if the order actually changed. Closes the window
    // either way once the save attempt (if any) completes.
    onSave: function() {
        var order = this.getCurrentOrder();
        var unchanged = order.length === this.originalOrder.length &&
            order.every(function(id, i) { return id === this[i]; }, this.originalOrder);

        if (unchanged) {
            this.close();
            return;
        }

        var self = this;
        var xhr = new XMLHttpRequest();
        var orderParam = order.map(function(id) { return encodeURIComponent(id); }).join(",");
        xhr.open("GET", AQC_API_BASE + "?action=save_lan_order&order=" + orderParam, true);
        xhr.onreadystatechange = function() {
            if (xhr.readyState !== 4) {
                return;
            }
            // Whether it succeeded, failed, or the response was unparseable,
            // the window still closes - there's no persistent UI left to
            // show an error in once it's gone. Failures are logged for now;
            // consider a toast/notify on the main DSM UI if silent failure
            // turns out to be a problem in practice.
            if (xhr.status !== 200) {
                console.log("AQC_Unlock: save_lan_order failed, HTTP " + xhr.status);
            } else {
                try {
                    var res = JSON.parse(xhr.responseText);
                    if (!res || res.ok !== true) {
                        console.log("AQC_Unlock: save_lan_order returned an error", res);
                    }
                } catch (e) {
                    console.log("AQC_Unlock: save_lan_order returned an invalid response");
                }
            }
            self.close();
        };
        xhr.onerror = function() {
            console.log("AQC_Unlock: save_lan_order request failed");
            self.close();
        };
        xhr.send();
    },

    onClose: function() {
        SYNO.SDS.AQC_Unlock.MainWindow.superclass.onClose.apply(this, arguments);
        this.doClose();
        return true;
    }
});
