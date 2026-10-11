/*
 * The launcher's other half.
 *
 * The window is only a face: everything it does — starting NodeCG, the
 * firewall rule, the sign-in — is done by `launcher/index.mjs`, a Node process
 * that this program starts and talks to over its control API on 127.0.0.1.
 * This file starts that process and makes the requests.
 *
 * Its messages use `T(ru, en)`, which the program defines before including it.
 */
#ifndef NOTGT_BACKEND_H
#define NOTGT_BACKEND_H

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <windows.h>
#include <winhttp.h>

typedef struct {
	HANDLE process; /* the Node process; NULL when attached to a running one */
	INTERNET_PORT port; /* of the control API */
	HINTERNET session;
	HINTERNET connection;
} Backend;

/* ------------------------------------------------------------- the process */

typedef struct {
	HANDLE pipe;
	HANDLE ready;
	char line[512];
} BackendBanner;

/*
 * Reads what the Node process prints. The first line is its banner —
 * "notGT launcher on http://127.0.0.1:<port>" — and the rest is read and
 * dropped, so that the process never blocks on a full pipe.
 */
static DWORD WINAPI backend_read_stdout(LPVOID param) {
	BackendBanner *banner = (BackendBanner *)param;
	size_t used = 0;
	BOOL signalled = FALSE;
	char chunk[512];
	DWORD got;
	while (ReadFile(banner->pipe, chunk, sizeof(chunk), &got, NULL) && got > 0) {
		if (signalled) continue;
		for (DWORD i = 0; i < got && !signalled; i++) {
			if (chunk[i] == '\n' || used + 1 >= sizeof(banner->line)) {
				banner->line[used] = '\0';
				signalled = TRUE;
				SetEvent(banner->ready);
			} else if (chunk[i] != '\r') {
				banner->line[used++] = chunk[i];
			}
		}
	}
	if (!signalled) SetEvent(banner->ready); /* the process ended without a banner */
	CloseHandle(banner->pipe);
	return 0;
}

static INTERNET_PORT backend_port_of(const char *text) {
	const char *marker = strstr(text, "127.0.0.1:");
	long port = marker ? strtol(marker + 10, NULL, 10) : 0;
	return port > 0 && port < 65536 ? (INTERNET_PORT)port : 0;
}

/*
 * Starts `"<node>" "<script>" --app "<app>" --no-open --background` with no
 * console window and waits for its banner.
 *
 * The process is not tied to this program's life: the window can be closed
 * while the server runs, and the process stays to look after the server (the
 * next window finds it — see backend_attach). It ends when it is told to
 * (POST /api/quit), or by itself once it has neither a server nor a window. Returns FALSE with a message for the user in
 * `error` when it does not come up.
 */
static BOOL backend_start(Backend *be, const wchar_t *node, const wchar_t *script, const wchar_t *app,
	const wchar_t *cwd, wchar_t *error, size_t errorLen) {
	SECURITY_ATTRIBUTES inherit = { sizeof(inherit), NULL, TRUE };
	HANDLE readEnd = NULL, writeEnd = NULL, nul;
	STARTUPINFOW si;
	PROCESS_INFORMATION pi;
	static BackendBanner banner; /* outlives this call: the reader thread keeps it */
	size_t cmdLen = wcslen(node) + wcslen(script) + wcslen(app) + 64;
	wchar_t *cmd = (wchar_t *)malloc(cmdLen * sizeof(wchar_t));
	BOOL started;

	if (!cmd || !CreatePipe(&readEnd, &writeEnd, &inherit, 0)) {
		free(cmd);
		_snwprintf(error, errorLen, T(L"Не удалось подготовить запуск (код %lu).", L"Could not prepare the start (code %lu)."), (unsigned long)GetLastError());
		return FALSE;
	}
	SetHandleInformation(readEnd, HANDLE_FLAG_INHERIT, 0);
	nul = CreateFileW(L"NUL", GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, &inherit,
		OPEN_EXISTING, 0, NULL);

	_snwprintf(cmd, cmdLen, L"\"%ls\" \"%ls\" --app \"%ls\" --no-open --background", node, script, app);
	ZeroMemory(&si, sizeof(si));
	si.cb = sizeof(si);
	si.dwFlags = STARTF_USESTDHANDLES;
	si.hStdInput = nul;
	si.hStdOutput = writeEnd;
	si.hStdError = nul;
	ZeroMemory(&pi, sizeof(pi));
	started = CreateProcessW(node, cmd, NULL, NULL, TRUE, CREATE_NO_WINDOW | CREATE_SUSPENDED, NULL, cwd, &si, &pi);
	free(cmd);
	CloseHandle(writeEnd);
	if (nul != INVALID_HANDLE_VALUE) CloseHandle(nul);
	if (!started) {
		_snwprintf(error, errorLen, T(L"Не удалось запустить node.exe (код ошибки %lu):\n\n%ls", L"node.exe could not be started (error code %lu):\n\n%ls"),
			(unsigned long)GetLastError(), node);
		CloseHandle(readEnd);
		return FALSE;
	}
	ResumeThread(pi.hThread);
	CloseHandle(pi.hThread);
	be->process = pi.hProcess;

	banner.pipe = readEnd;
	banner.ready = CreateEventW(NULL, TRUE, FALSE, NULL);
	banner.line[0] = '\0';
	CloseHandle(CreateThread(NULL, 0, backend_read_stdout, &banner, 0, NULL));
	if (WaitForSingleObject(banner.ready, 30000) == WAIT_OBJECT_0) be->port = backend_port_of(banner.line);
	if (be->port == 0) {
		_snwprintf(error, errorLen,
			T(L"Служебный процесс notGT не запустился.\n\n"
			  L"Проверьте, что ZIP-архив распакован целиком, и запустите программу снова.",
				L"notGT's service process did not start.\n\n"
				L"Check that the ZIP archive was unpacked completely, and start the program again."));
		return FALSE;
	}
	return TRUE;
}

/* TRUE while the Node process is alive (or was never ours to watch). */
static BOOL backend_alive(const Backend *be) {
	return !be->process || WaitForSingleObject(be->process, 0) == WAIT_TIMEOUT;
}

static void backend_close(Backend *be) {
	if (be->connection) WinHttpCloseHandle(be->connection);
	if (be->session) WinHttpCloseHandle(be->session);
	if (be->process) CloseHandle(be->process);
	ZeroMemory(be, sizeof(*be));
}

/* ---------------------------------------------------------------- requests */

static BOOL backend_connect(Backend *be) {
	be->session = WinHttpOpen(L"notGT Launcher", WINHTTP_ACCESS_TYPE_NO_PROXY, WINHTTP_NO_PROXY_NAME,
		WINHTTP_NO_PROXY_BYPASS, 0);
	if (!be->session) return FALSE;
	be->connection = WinHttpConnect(be->session, L"127.0.0.1", be->port, 0);
	return be->connection != NULL;
}

/*
 * One request to the control API. `body` is JSON (UTF-8) or NULL. Returns the
 * HTTP status, or 0 when the process did not answer; `*response` is the body,
 * to be freed by the caller.
 *
 * `patient` is for the requests that wait for a person: adding a firewall
 * rule answers only after the UAC prompt was dealt with.
 */
static DWORD backend_request(const Backend *be, const wchar_t *method, const wchar_t *path, const char *body,
	BOOL patient, char **response) {
	HINTERNET request;
	DWORD status = 0, size = sizeof(status), got;
	size_t used = 0, cap = 0;
	char *text = NULL;
	size_t bodyLen = body ? strlen(body) : 0;

	if (response) *response = NULL;
	request = WinHttpOpenRequest(be->connection, method, path, NULL, WINHTTP_NO_REFERER,
		WINHTTP_DEFAULT_ACCEPT_TYPES, 0);
	if (!request) return 0;
	WinHttpSetTimeouts(request, 2000, 2000, 5000, patient ? 180000 : 20000);
	if (!WinHttpSendRequest(request, body ? L"Content-Type: application/json\r\n" : WINHTTP_NO_ADDITIONAL_HEADERS,
			body ? (DWORD)-1 : 0, (LPVOID)body, (DWORD)bodyLen, (DWORD)bodyLen, 0) ||
		!WinHttpReceiveResponse(request, NULL)) {
		WinHttpCloseHandle(request);
		return 0;
	}
	WinHttpQueryHeaders(request, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_HEADER_NAME_BY_INDEX,
		&status, &size, WINHTTP_NO_HEADER_INDEX);
	for (;;) {
		if (used + 8192 + 1 > cap) {
			char *grown = (char *)realloc(text, cap = cap ? cap * 2 : 16384);
			if (!grown) break;
			text = grown;
		}
		if (!WinHttpReadData(request, text + used, 8192, &got) || got == 0) break;
		used += got;
	}
	WinHttpCloseHandle(request);
	if (text) text[used] = '\0';
	if (response) *response = text;
	else free(text);
	return status;
}

/* Appends `text` to a JSON document as a string literal. */
static void backend_json_string(char *out, size_t outLen, const wchar_t *text) {
	char utf8[2048];
	size_t n = strlen(out);
	int len = WideCharToMultiByte(CP_UTF8, 0, text, -1, utf8, sizeof(utf8), NULL, NULL);
	if (len <= 0) utf8[0] = '\0';
	if (n + 2 < outLen) out[n++] = '"';
	for (const unsigned char *c = (const unsigned char *)utf8; *c && n + 8 < outLen; c++) {
		if (*c == '"' || *c == '\\') {
			out[n++] = '\\';
			out[n++] = (char)*c;
		} else if (*c < 0x20) {
			n += (size_t)snprintf(out + n, outLen - n, "\\u%04x", *c);
		} else {
			out[n++] = (char)*c;
		}
	}
	if (n + 1 < outLen) out[n++] = '"';
	out[n] = '\0';
}

/*
 * Looks for a launcher that is already running — one whose window was closed
 * while the server was on air — and connects to it. `runtimeFile` is the note
 * it leaves (`{"pid":…,"port":…}`); the note alone proves nothing, so the
 * launcher is asked for its state before it is believed.
 */
static BOOL backend_attach(Backend *be, const wchar_t *runtimeFile) {
	char note[256] = "", *answer = NULL;
	const char *port;
	DWORD got = 0;
	BOOL alive;
	HANDLE file = CreateFileW(runtimeFile, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL,
		OPEN_EXISTING, 0, NULL);
	if (file == INVALID_HANDLE_VALUE) return FALSE;
	ReadFile(file, note, sizeof(note) - 1, &got, NULL);
	CloseHandle(file);
	note[got] = '\0';
	port = strstr(note, "\"port\":");
	be->port = port ? (INTERNET_PORT)strtol(port + 7, NULL, 10) : 0;
	if (!be->port || !backend_connect(be)) {
		backend_close(be);
		return FALSE;
	}
	alive = backend_request(be, L"GET", L"/api/state", NULL, FALSE, &answer) == 200 && answer &&
		strstr(answer, "\"status\"") != NULL;
	free(answer);
	if (!alive) backend_close(be);
	return alive;
}

#endif
