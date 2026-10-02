/*
 * aqcunlock-helper.c
 *
 * Narrow setuid-root launcher for Synology_AQC Unlock.
 * Installed by DSM owner root:<package>, mode 6550 (setuid+setgid), from
 * conf/privilege.
 *
 * Replaces the sudoers-based escalation (AQC_Unlock sudoers rules):
 * does not depend on /usr/bin/sudo being present, and only ever
 * executes one, hardcoded script path, with a single whitelisted
 * argument.
 *
 * Usage:
 *   aqcunlock-helper ACTION
 *   ACTION = start, stop, status or uninstall
 *
 * Every message this program prints starts with "aqcunlock-helper:" so
 * start-stop-status and api.cgi can tell a helper failure apart from
 * output of the root script itself.
 */

#define _GNU_SOURCE
#include <unistd.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <grp.h>
#include <sys/stat.h>

#define SCRIPT "/var/packages/AQC_Unlock/scripts/start-stop-status-root"

/* Replaces the whole environment (sudo used to provide its own).
 * Must match root's normal PATH on DSM - verify with: sudo -i; echo $PATH */
#define SAFE_PATH "/sbin:/bin:/usr/sbin:/usr/bin:/usr/syno/sbin:/usr/syno/bin:/usr/local/sbin:/usr/local/bin"

int main(int argc, char *argv[])
{
    /* killall and log are no-ops in the root script; the wrapper
     * handles them itself so they are deliberately not allowed here. */
    const char *allowed[] = { "start", "stop", "status", "uninstall", NULL };

    if (argc != 2) {
        fprintf(stderr, "aqcunlock-helper: wrong argument count\n");
        return 1;
    }

    int ok = 0;
    for (int i = 0; allowed[i] != NULL; i++) {
        if (strcmp(argv[1], allowed[i]) == 0) { ok = 1; break; }
    }
    if (!ok) {
        fprintf(stderr, "aqcunlock-helper: rejected option '%s'\n", argv[1]);
        return 1;
    }

    /* The setuid/setgid bits only set euid/egid. Make uid, gid and the
     * supplementary groups genuinely root's, so files the script creates
     * (ifcfg-*, ovs_interface.conf, ...) are root:root, as they were
     * under sudo. */
    if (setgroups(0, NULL) != 0 ||
        setresgid(0, 0, 0) != 0 ||
        setresuid(0, 0, 0) != 0) {
        perror("aqcunlock-helper: could not become root");
        return 1;
    }
    umask(022);

    /* Sanitize environment: nothing inherited, fixed PATH. */
    if (clearenv() != 0) {
        fprintf(stderr, "aqcunlock-helper: clearenv failed\n");
        return 1;
    }
    if (setenv("PATH", SAFE_PATH, 1) != 0) {
        fprintf(stderr, "aqcunlock-helper: setenv PATH failed\n");
        return 1;
    }

    execl(SCRIPT, SCRIPT, argv[1], (char *)NULL);

    perror("aqcunlock-helper: execl failed");
    return 1;
}
