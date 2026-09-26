/*
 * notGT Launcher — native Windows bootstrap for the portable notGT package.
 *
 * Why this exists:
 *   The portable package ships a bundled Node runtime plus the real launcher
 *   (`launcher/index.mjs`), which serves the control UI and starts NodeCG on
 *   demand. The user should be able to start it with a double click and see
 *   NOTHING else: no console window flashing up and staying open behind the
 *   browser. `notGT.cmd` cannot do that (a .cmd always gets a console), so this
 *   tiny GUI-subsystem wrapper starts the bundled node.exe with
 *   CREATE_NO_WINDOW and exits immediately. The actual UI is the launcher web
 *   page that `launcher/index.mjs` serves and opens in the browser.
 *
 * It deliberately depends on nothing beyond kernel32/user32 (no shlwapi):
 * the file's own directory is trimmed out of GetModuleFileNameW by hand.
 *
 * Build (mingw-w64):
 *   x86_64-w64-mingw32-gcc -O2 -municode -mwindows \
 *     -o "notGT Launcher.exe" launcher/win/notGT-launcher.c
 */

#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif

#include <windows.h>

/* Extended-length paths; the default MAX_PATH is too small. */
#define NOTGT_MAX_PATH 32768
/* Worst case: three quoted NOTGT_MAX_PATH paths + flags + NULs. */
#define NOTGT_CMDLINE_MAX (NOTGT_MAX_PATH * 4)

/* TRUE when `p` names an existing non-directory file. */
static BOOL notgt_is_file(const wchar_t *p) {
	DWORD attrs = GetFileAttributesW(p);
	return attrs != INVALID_FILE_ATTRIBUTES && (attrs & FILE_ATTRIBUTE_DIRECTORY) == 0;
}

/* TRUE when `p` names an existing directory. */
static BOOL notgt_is_dir(const wchar_t *p) {
	DWORD attrs = GetFileAttributesW(p);
	return attrs != INVALID_FILE_ATTRIBUTES && (attrs & FILE_ATTRIBUTE_DIRECTORY) != 0;
}

/* Show a Russian error box naming the offending path and bail out. */
static int notgt_fail(const wchar_t *what, const wchar_t *path) {
	wchar_t msg[NOTGT_MAX_PATH + 512];
	wsprintfW(msg,
		L"Не найден %ls:\n\n%ls\n\n"
		L"Похоже, ZIP-архив распакован не полностью. Распакуйте его целиком "
		L"в отдельную папку и запустите «notGT Launcher.exe» из неё.",
		what, path);
	MessageBoxW(NULL, msg, L"notGT — ошибка запуска",
		MB_OK | MB_ICONERROR | MB_SETFOREGROUND | MB_TOPMOST);
	return 1;
}

int wmain(void) {
	wchar_t exePath[NOTGT_MAX_PATH];
	DWORD len = GetModuleFileNameW(NULL, exePath, NOTGT_MAX_PATH);
	if (len == 0 || len >= NOTGT_MAX_PATH) {
		MessageBoxW(NULL,
			L"Не удалось определить папку программы. Запустите «notGT Launcher.exe» "
			L"из распакованной папки notGT-win-x64.",
			L"notGT — ошибка запуска",
			MB_OK | MB_ICONERROR | MB_SETFOREGROUND | MB_TOPMOST);
		return 1;
	}

	/* Trim "\notGT Launcher.exe" (or whatever the exe was renamed to). */
	wchar_t *lastSep = wcsrchr(exePath, L'\\');
	if (lastSep == NULL) {
		wcscpy_s(exePath, NOTGT_MAX_PATH, L".");
	} else {
		*lastSep = L'\0';
	}

	wchar_t nodePath[NOTGT_MAX_PATH];
	wchar_t scriptPath[NOTGT_MAX_PATH];
	wchar_t appPath[NOTGT_MAX_PATH];
	wchar_t cmdLine[NOTGT_CMDLINE_MAX];

	wsprintfW(nodePath, L"%ls\\node\\node.exe", exePath);
	wsprintfW(scriptPath, L"%ls\\launcher\\index.mjs", exePath);
	wsprintfW(appPath, L"%ls\\app", exePath);

	if (!notgt_is_file(nodePath)) {
		return notgt_fail(L"файл node\\node.exe", nodePath);
	}
	if (!notgt_is_file(scriptPath)) {
		return notgt_fail(L"файл launcher\\index.mjs", scriptPath);
	}
	if (!notgt_is_dir(appPath)) {
		return notgt_fail(L"папка app", appPath);
	}

	/* "<dir>\node\node.exe" "<dir>\launcher\index.mjs" --app "<dir>\app" */
	wsprintfW(cmdLine, L"\"%ls\" \"%ls\" --app \"%ls\"",
		nodePath, scriptPath, appPath);

	STARTUPINFOW si;
	PROCESS_INFORMATION pi;
	ZeroMemory(&si, sizeof(si));
	si.cb = sizeof(si);
	ZeroMemory(&pi, sizeof(pi));

	/* The launcher keeps running as the app; we do not wait for it.
	 * cwd is the package root; launcher/index.mjs resolves --app itself. */
	if (!CreateProcessW(nodePath, cmdLine, NULL, NULL, FALSE, CREATE_NO_WINDOW,
			NULL, exePath, &si, &pi)) {
		wchar_t msg[NOTGT_MAX_PATH + 512];
		wsprintfW(msg,
			L"Не удалось запустить node.exe (код ошибки %lu):\n\n%ls",
			(unsigned long)GetLastError(), nodePath);
		MessageBoxW(NULL, msg, L"notGT — ошибка запуска",
			MB_OK | MB_ICONERROR | MB_SETFOREGROUND | MB_TOPMOST);
		return 1;
	}

	CloseHandle(pi.hThread);
	CloseHandle(pi.hProcess);
	return 0;
}
