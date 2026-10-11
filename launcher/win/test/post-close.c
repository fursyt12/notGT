/*
 * Asks the launcher's main window to close, the way its close box does — for
 * scripts/e2e-launcher-window.mjs, which runs the launcher in a virtual
 * display that has no window manager and so no close box to click.
 * Exit code: 0 when the window was found.
 */
#include <windows.h>

int main(void) {
	HWND hwnd = FindWindowW(L"notGTLauncher", NULL);
	if (!hwnd) return 1;
	PostMessageW(hwnd, WM_CLOSE, 0, 0);
	return 0;
}
