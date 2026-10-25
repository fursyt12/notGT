/*
 * Talks to the karaoke's main window the way Windows does — for
 * scripts/e2e-karaoke.mjs, which runs it in a virtual display that has no
 * window manager (no close box) and no notification area (no tray menu).
 *
 *   post close     WM_CLOSE, as the close box sends it
 *   post quit      the tray menu's "Quit"
 *   post visible   exit code 0 when the window is shown, 2 when hidden
 *
 * Exit code 1: no such window.
 */
#include <windows.h>

#define ID_TRAY_QUIT 201 /* as in notGT-karaoke.c */

int wmain(int argc, wchar_t **argv) {
	HWND hwnd = FindWindowW(L"notGTKaraoke", NULL);
	if (!hwnd) return 1;
	if (argc > 1 && !lstrcmpW(argv[1], L"close")) PostMessageW(hwnd, WM_CLOSE, 0, 0);
	else if (argc > 1 && !lstrcmpW(argv[1], L"quit")) PostMessageW(hwnd, WM_COMMAND, ID_TRAY_QUIT, 0);
	else return IsWindowVisible(hwnd) ? 0 : 2;
	return 0;
}
