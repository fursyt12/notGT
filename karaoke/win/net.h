/*
 * The network of notGT Karaoke: HTTPS requests to the lyrics sources and the
 * WebSocket to notGT, both through WinHTTP, which Windows has anyway.
 *
 * Every call here blocks; the program makes them from its worker threads.
 */
#ifndef KARAOKE_NET_H
#define KARAOKE_NET_H

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <windows.h>
#include <winhttp.h>

#ifndef WINHTTP_OPTION_DECOMPRESSION
#define WINHTTP_OPTION_DECOMPRESSION 118
#define WINHTTP_DECOMPRESSION_FLAG_ALL 3
#endif
#ifndef WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY
#define WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY 4
#endif

static HINTERNET g_http;

/* One session for the whole program: WinHTTP keeps the connections of a
 * session alive, so a source asked twice does not shake hands twice. */
static BOOL net_init(void) {
	g_http = WinHttpOpen(L"notGT-karaoke/1.0", WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_NO_PROXY_NAME,
		WINHTTP_NO_PROXY_BYPASS, 0);
	if (!g_http) /* before Windows 8.1 */
		g_http = WinHttpOpen(L"notGT-karaoke/1.0", WINHTTP_ACCESS_TYPE_DEFAULT_PROXY, WINHTTP_NO_PROXY_NAME,
			WINHTTP_NO_PROXY_BYPASS, 0);
	return g_http != NULL;
}

/* UTF-16 -> a newly allocated UTF-8 string. */
static char *utf8_of(const wchar_t *text) {
	int len = WideCharToMultiByte(CP_UTF8, 0, text ? text : L"", -1, NULL, 0, NULL, NULL);
	char *out = (char *)malloc(len > 0 ? (size_t)len : 1);
	if (!out) return NULL;
	if (len <= 0) out[0] = '\0';
	else WideCharToMultiByte(CP_UTF8, 0, text ? text : L"", -1, out, len, NULL, NULL);
	return out;
}

/* Appends `text` to `out` percent-encoded for a query string. */
static void url_encode(wchar_t *out, size_t cap, const wchar_t *text) {
	char *utf8 = utf8_of(text);
	size_t n = wcslen(out);
	for (const unsigned char *c = (const unsigned char *)(utf8 ? utf8 : ""); *c && n + 4 < cap; c++) {
		if ((*c >= 'a' && *c <= 'z') || (*c >= 'A' && *c <= 'Z') || (*c >= '0' && *c <= '9') || *c == '-' ||
			*c == '_' || *c == '.' || *c == '~') {
			out[n++] = (wchar_t)*c;
		} else {
			n += (size_t)_snwprintf(out + n, cap - n, L"%%%02X", *c);
		}
	}
	out[n] = L'\0';
	free(utf8);
}

/* Appends `&key=value` (or `?key=value` for the first one) to a URL. */
static void url_param(wchar_t *url, size_t cap, const wchar_t *key, const wchar_t *value) {
	size_t n = wcslen(url);
	_snwprintf(url + n, cap - n, L"%lc%ls=", wcschr(url, L'?') ? L'&' : L'?', key);
	url[cap - 1] = L'\0';
	url_encode(url, cap, value);
}

/* Splits a URL into host, port, path+query and whether it is secure. */
static BOOL url_split(const wchar_t *url, wchar_t *host, wchar_t *path, INTERNET_PORT *port, BOOL *secure) {
	URL_COMPONENTS parts;
	wchar_t query[2048];
	ZeroMemory(&parts, sizeof(parts));
	parts.dwStructSize = sizeof(parts);
	parts.lpszHostName = host;
	parts.dwHostNameLength = 256;
	parts.lpszUrlPath = path;
	parts.dwUrlPathLength = 2048;
	parts.lpszExtraInfo = query;
	parts.dwExtraInfoLength = 2048;
	if (!WinHttpCrackUrl(url, 0, 0, &parts)) return FALSE;
	wcsncat(path, query, 4095 - wcslen(path)); /* the query goes after the path */
	*port = parts.nPort;
	*secure = parts.nScheme == INTERNET_SCHEME_HTTPS;
	return TRUE;
}

/*
 * GET `url`. Returns the body as a NUL-terminated UTF-8 string (free it), or
 * NULL when nothing came back at all; `*status` is the HTTP status, or 0.
 */
static char *http_get(const wchar_t *url, const wchar_t *headers, DWORD timeoutMs, DWORD *status) {
	wchar_t host[256], path[4096];
	INTERNET_PORT port;
	BOOL secure;
	HINTERNET connection = NULL, request = NULL;
	DWORD code = 0, size = sizeof(code), got = 0, flags = WINHTTP_DECOMPRESSION_FLAG_ALL;
	size_t used = 0, cap = 0;
	char *body = NULL;

	if (status) *status = 0;
	if (!g_http || !url_split(url, host, path, &port, &secure)) return NULL;
	connection = WinHttpConnect(g_http, host, port, 0);
	if (connection)
		request = WinHttpOpenRequest(connection, L"GET", path, NULL, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES,
			secure ? WINHTTP_FLAG_SECURE : 0);
	if (!request) goto done;
	WinHttpSetTimeouts(request, (int)timeoutMs, (int)timeoutMs, (int)timeoutMs, (int)timeoutMs);
	/* Gzip when Windows can unpack it (8.1 and later); plain text otherwise. */
	WinHttpSetOption(request, WINHTTP_OPTION_DECOMPRESSION, &flags, sizeof(flags));
	if (!WinHttpSendRequest(request, headers ? headers : WINHTTP_NO_ADDITIONAL_HEADERS, headers ? (DWORD)-1 : 0,
			WINHTTP_NO_REQUEST_DATA, 0, 0, 0) ||
		!WinHttpReceiveResponse(request, NULL))
		goto done;
	WinHttpQueryHeaders(request, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_HEADER_NAME_BY_INDEX,
		&code, &size, WINHTTP_NO_HEADER_INDEX);
	for (;;) {
		if (used + 16384 + 1 > cap) {
			char *grown = (char *)realloc(body, cap = cap ? cap * 2 : 65536);
			if (!grown) break;
			body = grown;
		}
		if (!WinHttpReadData(request, body + used, 16384, &got) || got == 0) break;
		used += got;
	}
	if (body) body[used] = '\0';
	if (status) *status = code;
done:
	if (request) WinHttpCloseHandle(request);
	if (connection) WinHttpCloseHandle(connection);
	if (!code) {
		free(body);
		body = NULL;
	}
	return body;
}

/* --------------------------------------------------- several at a time */

typedef struct {
	wchar_t url[2048];
	const wchar_t *headers;
	DWORD timeoutMs;
	char *body; /* free it */
	DWORD status; /* 0 = no answer */
} Fetch;

static DWORD WINAPI fetch_thread(LPVOID param) {
	Fetch *f = (Fetch *)param;
	f->body = http_get(f->url, f->headers, f->timeoutMs, &f->status);
	return 0;
}

/* Runs the requests at the same time and waits for all of them (each has its
 * own timeout, so this ends). */
static void fetch_all(Fetch *fetches, int n) {
	HANDLE threads[16];
	DWORD started = 0;
	for (int i = 0; i < n && i < 16; i++) {
		threads[started] = CreateThread(NULL, 0, fetch_thread, &fetches[i], 0, NULL);
		if (threads[started]) started++;
		else fetch_thread(&fetches[i]);
	}
	if (started) WaitForMultipleObjects(started, threads, TRUE, INFINITE);
	for (DWORD i = 0; i < started; i++) CloseHandle(threads[i]);
}

/* ------------------------------------------------------------ WebSocket */

#ifndef WINHTTP_OPTION_UPGRADE_TO_WEB_SOCKET
#define WINHTTP_OPTION_UPGRADE_TO_WEB_SOCKET 114
#endif

/* WinHTTP's WebSocket calls exist from Windows 8 on; they are looked up at run
 * time so that the program still starts (and says why it cannot connect) on
 * an older system. */
typedef HINTERNET(WINAPI *WsUpgrade)(HINTERNET, DWORD_PTR);
typedef DWORD(WINAPI *WsSend)(HINTERNET, int, PVOID, DWORD);
typedef DWORD(WINAPI *WsReceive)(HINTERNET, PVOID, DWORD, DWORD *, int *);
typedef DWORD(WINAPI *WsClose)(HINTERNET, USHORT, PVOID, DWORD);
typedef DWORD(WINAPI *WsQueryClose)(HINTERNET, USHORT *, PVOID, DWORD, DWORD *);
typedef DWORD(WINAPI *WsShutdown)(HINTERNET, USHORT, PVOID, DWORD);

static WsUpgrade p_wsUpgrade;
static WsSend p_wsSend;
static WsReceive p_wsReceive;
static WsClose p_wsClose;
static WsQueryClose p_wsQueryClose;
static WsShutdown p_wsShutdown;

enum { WS_BUF_UTF8_MESSAGE = 2, WS_BUF_UTF8_FRAGMENT = 3, WS_BUF_CLOSE = 4 };

static BOOL ws_supported(void) {
	HMODULE dll = GetModuleHandleW(L"winhttp.dll");
	if (!dll) return FALSE;
	p_wsUpgrade = (WsUpgrade)(void *)GetProcAddress(dll, "WinHttpWebSocketCompleteUpgrade");
	p_wsSend = (WsSend)(void *)GetProcAddress(dll, "WinHttpWebSocketSend");
	p_wsReceive = (WsReceive)(void *)GetProcAddress(dll, "WinHttpWebSocketReceive");
	p_wsClose = (WsClose)(void *)GetProcAddress(dll, "WinHttpWebSocketClose");
	p_wsQueryClose = (WsQueryClose)(void *)GetProcAddress(dll, "WinHttpWebSocketQueryCloseStatus");
	p_wsShutdown = (WsShutdown)(void *)GetProcAddress(dll, "WinHttpWebSocketShutdown");
	return p_wsUpgrade && p_wsSend && p_wsReceive && p_wsClose && p_wsShutdown;
}

/* One connection. Sending and receiving may happen on two threads at once;
 * two sends may not (the program sends under a lock of its own). */
typedef struct {
	HINTERNET connection;
	HINTERNET socket;
} WebSocket;

/*
 * Opens `url` (ws:// or wss://). FALSE when it did not: `*httpStatus` is the
 * answer to the handshake (0 = nobody answered).
 */
static BOOL ws_open(WebSocket *ws, const wchar_t *url, DWORD *httpStatus) {
	wchar_t web[4200], host[256], path[4096];
	const wchar_t *rest = wcsstr(url, L"://");
	INTERNET_PORT port;
	BOOL secure = !_wcsnicmp(url, L"wss://", 6);
	HINTERNET request = NULL;
	DWORD code = 0, size = sizeof(code);

	*httpStatus = 0;
	ws->connection = ws->socket = NULL;
	/* WinHttpCrackUrl knows http(s) only: ws -> http, wss -> https. */
	_snwprintf(web, 4200, L"%ls%ls", secure ? L"https://" : L"http://", rest ? rest + 3 : url);
	web[4199] = L'\0';
	if (!url_split(web, host, path, &port, &secure)) return FALSE;
	ws->connection = WinHttpConnect(g_http, host, port, 0);
	if (ws->connection)
		request = WinHttpOpenRequest(ws->connection, L"GET", path, NULL, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES,
			secure ? WINHTTP_FLAG_SECURE : 0);
	if (!request || !WinHttpSetOption(request, WINHTTP_OPTION_UPGRADE_TO_WEB_SOCKET, NULL, 0)) goto failed;
	WinHttpSetTimeouts(request, 3000, 3000, 5000, 5000);
	if (!WinHttpSendRequest(request, WINHTTP_NO_ADDITIONAL_HEADERS, 0, WINHTTP_NO_REQUEST_DATA, 0, 0, 0) ||
		!WinHttpReceiveResponse(request, NULL))
		goto failed;
	WinHttpQueryHeaders(request, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_HEADER_NAME_BY_INDEX,
		&code, &size, WINHTTP_NO_HEADER_INDEX);
	*httpStatus = code;
	if (code != 101) goto failed;
	ws->socket = p_wsUpgrade(request, 0);
	WinHttpCloseHandle(request);
	request = NULL;
	if (!ws->socket) goto failed;
	{
		/* A receive waits for as long as notGT is quiet (it pings every 30 s). */
		DWORD none = 0;
		WinHttpSetOption(ws->socket, WINHTTP_OPTION_RECEIVE_TIMEOUT, &none, sizeof(none));
	}
	return TRUE;
failed:
	if (request) WinHttpCloseHandle(request);
	if (ws->connection) WinHttpCloseHandle(ws->connection);
	ws->connection = NULL;
	return FALSE;
}

static BOOL ws_send(WebSocket *ws, const char *utf8) {
	return ws->socket && p_wsSend(ws->socket, WS_BUF_UTF8_MESSAGE, (PVOID)utf8, (DWORD)strlen(utf8)) == NO_ERROR;
}

/* Asks notGT to end the connection without waiting for it: the receive that
 * waits in another thread then returns, and that thread closes it. */
static void ws_shutdown(WebSocket *ws) {
	if (ws->socket) p_wsShutdown(ws->socket, 1000, NULL, 0);
}

/*
 * Waits for the next text message. Returns it (free it), or NULL when the
 * connection is over; `*closeCode` is the code notGT closed it with, if any.
 */
static char *ws_receive(WebSocket *ws, USHORT *closeCode) {
	size_t used = 0, cap = 8192;
	char *text = (char *)malloc(cap);
	*closeCode = 0;
	if (!text) return NULL;
	for (;;) {
		DWORD got = 0;
		int type = 0;
		if (used + 4096 + 1 > cap) {
			char *grown = (char *)realloc(text, cap *= 2);
			if (!grown) break;
			text = grown;
		}
		if (p_wsReceive(ws->socket, text + used, (DWORD)(cap - used - 1), &got, &type) != NO_ERROR) break;
		if (type == WS_BUF_CLOSE) {
			USHORT code = 0;
			DWORD reasonLen = 0;
			char reason[128];
			if (p_wsQueryClose) p_wsQueryClose(ws->socket, &code, reason, sizeof(reason), &reasonLen);
			*closeCode = code;
			break;
		}
		used += got;
		if (type == WS_BUF_UTF8_MESSAGE) {
			text[used] = '\0';
			return text;
		}
		if (type != WS_BUF_UTF8_FRAGMENT) used = 0; /* a binary message: not for us */
	}
	free(text);
	return NULL;
}

/* Frees the connection; only the thread that receives does this. */
static void ws_close(WebSocket *ws) {
	if (ws->socket) WinHttpCloseHandle(ws->socket);
	if (ws->connection) WinHttpCloseHandle(ws->connection);
	ws->socket = ws->connection = NULL;
}

#endif
