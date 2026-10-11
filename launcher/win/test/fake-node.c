/*
 * A stand-in for the bundled node.exe, for testing the launcher's window
 * without Windows: scripts/e2e-launcher-window.mjs runs the launcher under
 * wine, where a real Node for Windows is more trouble than it is worth. The
 * real `launcher/index.mjs` runs on the host instead, and this program plays
 * the process the launcher starts:
 *
 *   - it prints the banner the launcher waits for, pointing at the host's
 *     control API (the port comes from NOTGT_FAKE_PORT),
 *   - it keeps touching NOTGT_FAKE_HEARTBEAT, so the test can tell that it
 *     was started — and that it was taken down when the launcher quit.
 */
#include <stdio.h>
#include <stdlib.h>
#include <windows.h>

int main(void) {
	const char *port = getenv("NOTGT_FAKE_PORT");
	const char *heartbeat = getenv("NOTGT_FAKE_HEARTBEAT");
	unsigned long beat = 0;
	printf("notGT launcher on http://127.0.0.1:%s\n", port ? port : "0");
	fflush(stdout);
	for (;;) {
		if (heartbeat) {
			FILE *file = fopen(heartbeat, "w");
			if (file) {
				fprintf(file, "%lu\n", ++beat);
				fclose(file);
			}
		}
		Sleep(200);
	}
}
