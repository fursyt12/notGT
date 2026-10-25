/*
 * notGT Lyrics Bridge — lyrics of what Spotify plays, line by line, into notGT.
 *
 * It reads the playing track and its position from Windows (the media
 * controls Spotify reports to, see smtc.h), finds synced lyrics (LRCLIB,
 * NetEase, and Musixmatch with a token of your own — lyrics.h) and sends the
 * line being sung to notGT over its WebSocket API, as the `karaoke.*`
 * variables the "Karaoke" title of the examples library shows:
 *
 *   karaoke.artist / .title                the track
 *   karaoke.prev / .cur / .next / .next2   the lines around the one sung
 *   karaoke.pos                            ms into the current line when sent
 *   karaoke.dur / .sing                    ms until the next line / that the line is sung
 *   karaoke.wt                             word timing "start:end,..." (ms in the line), when known
 *   karaoke.playing / .seq                 1 while playing; bumped on every frame
 *
 * A song often has several timings in the sources. All of them are kept as
 * variants: the best one is shown (see rank_variants), and the window, the
 * tray menu and the cache let the operator pick another and shift the text of
 * a track; both choices are remembered for that track.
 *
 * Closing the window hides it: the program goes on in the notification area,
 * whose menu has the same controls and "Quit".
 *
 * It is the launcher's sibling (launcher/win/notGT-launcher.c): the same look,
 * drawn by the same few helpers, and nothing but Windows itself — user32,
 * gdi32, gdiplus, shell32, winhttp, crypt32, ole32 and, at run time, combase
 * for the media controls (Windows 10 1809 or later).
 *
 * Build (mingw-w64) — scripts/build-windows.mjs does this:
 *   x86_64-w64-mingw32-windres notGT-lyrics-bridge.rc -O coff -o bridge-res.o
 *   x86_64-w64-mingw32-gcc -O2 -municode -mwindows -o notgt-lyrics-bridge.exe \
 *     notGT-lyrics-bridge.c bridge-res.o -lwinhttp -lgdiplus -lole32 -lshell32 -lgdi32 -lcomctl32 -lcrypt32
 *
 * For development and tests (see scripts/e2e-lyrics-bridge.mjs):
 *   --simulate                     a built-in demo song instead of Spotify
 *   --fake "Artist|Title|s|from"   play that track (s long, from second `from`) instead of Spotify
 *   --settings <file>              keep the settings there instead of %APPDATA%\notGT\lyrics-bridge.json
 *   --cache <dir>                  the cache of lyrics there instead of %LOCALAPPDATA%\notGT\lyrics-bridge
 *   --log-file <file>              also write the journal there (UTF-8)
 *   --command <n|p|+|-|0|r>@<s>    press a button s seconds after the start (may repeat)
 *   --snapshot <dir>               save pictures of every window as .bmp, then exit
 *   --snapshot-after <s>           when to take the first picture (default 4 s)
 *   --hidden                       start in the notification area only
 */

#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#define _WIN32_WINNT 0x0A00
#define WIN32_LEAN_AND_MEAN

#include <windows.h>
#include <commctrl.h>
#include <objidl.h>
#include <shellapi.h>
#include <shlobj.h>
#include <wincrypt.h>
#include <math.h>
#include <stdarg.h>
#include <wchar.h>

/* Russian and English, side by side, as in the launcher. */
static int g_lang; /* 0 = Russian, 1 = English */
#define T(ru, en) (g_lang ? (en) : (ru))

#include "../../launcher/win/json.h"
#include "net.h"
#include "smtc.h"
#include "lyrics.h"

/* ------------------------------------------------------------------- brand */
/* The dark theme of the dashboard, as in the launcher. */
#define C_BG RGB(0x0c, 0x2b, 0x25)
#define C_CARD RGB(0x12, 0x36, 0x30)
#define C_CONTROL RGB(0x1a, 0x44, 0x3c)
#define C_CONTROL_HOT RGB(0x22, 0x52, 0x48)
#define C_LINE RGB(0x2c, 0x5a, 0x4f)
#define C_WELL RGB(0x08, 0x20, 0x19)
#define C_TEXT RGB(0xf5, 0xec, 0xda)
#define C_MUTED RGB(0xa9, 0xb8, 0xa8)
#define C_FAINT RGB(0x6f, 0x8a, 0x7e)
#define C_SIGNAL RGB(0xff, 0x5a, 0x8c)
#define C_SIGNAL_HOT RGB(0xff, 0x7a, 0xa2)
#define C_LEMON RGB(0xff, 0xd2, 0x3f)
#define C_AMBER RGB(0xff, 0x9f, 0x43)

#define WM_APP_VIEW (WM_APP + 1) /* the engine has news for the window */
#define WM_APP_LOG (WM_APP + 2) /* a line was added to the journal */
#define WM_APP_TRAY (WM_APP + 3)

enum {
	ID_ADDRESS = 100,
	ID_KEY,
	ID_CONNECT,
	ID_PREV,
	ID_NEXT,
	ID_SEARCH,
	ID_EARLIER,
	ID_RESET,
	ID_LATER,
	ID_SHOW_MXM,
	ID_SHOW_LOG,
	ID_LANG_RU,
	ID_LANG_EN,
	ID_MXM_TOKEN,
	ID_MXM_SAVE,
	ID_MXM_CLEAR,
	ID_LOG_TEXT,
	/* fixed: test/post.c sends them */
	ID_TRAY_SHOW = 200,
	ID_TRAY_QUIT = 201,
};

enum { BTN_NORMAL, BTN_PRIMARY, BTN_GHOST, BTN_LANG };

/* What the window asks the engine to do. */
enum { CMD_NEXT = 1, CMD_PREV, CMD_LATER, CMD_EARLIER, CMD_RESET, CMD_SEARCH };

static HINSTANCE g_instance;
static HWND g_main, g_mxmWnd, g_logWnd;
static int g_dpi = 96;
static HFONT g_font, g_fontBold, g_fontSmall, g_fontCaps, g_fontBig, g_fontMono;
static HBRUSH g_brushWell;
static HBITMAP g_logo;
static int g_logoW, g_logoH;
static HICON g_icon, g_iconSmall;
static NOTIFYICONDATAW g_tray;
static BOOL g_hintShown;
static HANDLE g_quit, g_engineWake, g_wsWake;
static wchar_t g_snapshotDir[MAX_PATH];

static int S(int v) {
	return MulDiv(v, g_dpi, 96);
}

static RECT R(int x, int y, int w, int h) {
	RECT r = { S(x), S(y), S(x + w), S(y + h) };
	return r;
}

static void copy_str(wchar_t *out, size_t len, const wchar_t *value) {
	wcsncpy(out, value ? value : L"", len - 1);
	out[len - 1] = L'\0';
}

/* UTF-8 -> a newly allocated UTF-16 string. */
static wchar_t *wide_of_utf8(const char *text) {
	int len = MultiByteToWideChar(CP_UTF8, 0, text, -1, NULL, 0);
	wchar_t *out = len > 0 ? (wchar_t *)malloc((size_t)len * sizeof(wchar_t)) : NULL;
	if (out) MultiByteToWideChar(CP_UTF8, 0, text, -1, out, len);
	return out;
}

/* ------------------------------------------------------------------ journal */

#define LOG_LINES 600

static CRITICAL_SECTION g_logLock;
static wchar_t *g_log[LOG_LINES];
static int g_logCount; /* lines ever written; the last LOG_LINES are kept */
static HANDLE g_logFile = INVALID_HANDLE_VALUE;

static void log_line(const wchar_t *format, ...) {
	wchar_t line[1200];
	va_list args;
	va_start(args, format);
	_vsnwprintf(line, 1200, format, args);
	va_end(args);
	line[1199] = L'\0';
	EnterCriticalSection(&g_logLock);
	free(g_log[g_logCount % LOG_LINES]);
	g_log[g_logCount % LOG_LINES] = wdup(line);
	g_logCount++;
	if (g_logFile != INVALID_HANDLE_VALUE) {
		char *utf8 = utf8_of(line);
		DWORD wrote;
		if (utf8) {
			WriteFile(g_logFile, utf8, (DWORD)strlen(utf8), &wrote, NULL);
			WriteFile(g_logFile, "\r\n", 2, &wrote, NULL);
			free(utf8);
		}
	}
	LeaveCriticalSection(&g_logLock);
	if (g_main) PostMessageW(g_main, WM_APP_LOG, 0, 0);
}

/* ----------------------------------------------------------------- settings */

typedef struct {
	wchar_t address[512]; /* "localhost:9090", or a whole ws:// URL */
	wchar_t key[256]; /* the WebSocket key of notGT */
	wchar_t mxm[256]; /* a Musixmatch user token */
	int lang; /* -1 = the language of Windows */
} Settings;

static CRITICAL_SECTION g_settingsLock;
static Settings g_settings;
static wchar_t g_settingsPath[MAX_PATH], g_cacheDir[MAX_PATH];

/* The keys are kept encrypted for this Windows user (DPAPI), as base64. */
static void protect(const wchar_t *plain, Text *out) {
	DATA_BLOB in, sealed;
	wchar_t b64[4096];
	DWORD len = 4096;
	in.pbData = (BYTE *)plain;
	in.cbData = (DWORD)(wcslen(plain) * sizeof(wchar_t));
	if (!plain[0] || !CryptProtectData(&in, L"notGT", NULL, NULL, NULL, CRYPTPROTECT_UI_FORBIDDEN, &sealed)) {
		text_str(out, L"");
		return;
	}
	if (CryptBinaryToStringW(sealed.pbData, sealed.cbData, CRYPT_STRING_BASE64 | CRYPT_STRING_NOCRLF, b64, &len))
		text_str(out, b64);
	else
		text_str(out, L"");
	LocalFree(sealed.pbData);
}

static void unprotect(const wchar_t *b64, wchar_t *out, size_t outLen) {
	BYTE raw[4096];
	DWORD len = sizeof(raw);
	DATA_BLOB in, plain;
	out[0] = L'\0';
	if (!b64[0] || !CryptStringToBinaryW(b64, 0, CRYPT_STRING_BASE64, raw, &len, NULL, NULL)) return;
	in.pbData = raw;
	in.cbData = len;
	if (!CryptUnprotectData(&in, NULL, NULL, NULL, NULL, CRYPTPROTECT_UI_FORBIDDEN, &plain)) return;
	len = plain.cbData / sizeof(wchar_t);
	if (len >= outLen) len = (DWORD)outLen - 1;
	memcpy(out, plain.pbData, len * sizeof(wchar_t));
	out[len] = L'\0';
	SecureZeroMemory(plain.pbData, plain.cbData);
	LocalFree(plain.pbData);
}

static void settings_load(void) {
	HANDLE file = CreateFileW(g_settingsPath, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, 0, NULL);
	char body[16384];
	DWORD got = 0;
	JVal *doc = NULL;
	copy_str(g_settings.address, 512, L"localhost:9090");
	g_settings.lang = -1;
	if (file != INVALID_HANDLE_VALUE) {
		ReadFile(file, body, sizeof(body) - 1, &got, NULL);
		CloseHandle(file);
		body[got] = '\0';
		doc = json_parse(body);
	}
	if (!doc) return;
	if (*json_str(doc, L"address")) copy_str(g_settings.address, 512, json_str(doc, L"address"));
	unprotect(json_str(doc, L"key"), g_settings.key, 256);
	unprotect(json_str(doc, L"mxm"), g_settings.mxm, 256);
	if (!wcscmp(json_str(doc, L"lang"), L"ru")) g_settings.lang = 0;
	if (!wcscmp(json_str(doc, L"lang"), L"en")) g_settings.lang = 1;
	json_free(doc);
}

static void settings_save(void) {
	Text t = { 0 };
	HANDLE file;
	DWORD wrote;
	wchar_t dir[MAX_PATH], *slash;
	EnterCriticalSection(&g_settingsLock);
	text_raw(&t, "{\"address\":");
	text_str(&t, g_settings.address);
	text_raw(&t, ",\"key\":");
	protect(g_settings.key, &t);
	text_raw(&t, ",\"mxm\":");
	protect(g_settings.mxm, &t);
	text_printf(&t, ",\"lang\":\"%s\"}", g_settings.lang < 0 ? "" : g_settings.lang ? "en" : "ru");
	LeaveCriticalSection(&g_settingsLock);
	copy_str(dir, MAX_PATH, g_settingsPath);
	slash = wcsrchr(dir, L'\\');
	if (slash) {
		*slash = L'\0';
		SHCreateDirectoryExW(NULL, dir, NULL);
	}
	file = t.s ? CreateFileW(g_settingsPath, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL)
			   : INVALID_HANDLE_VALUE;
	if (file != INVALID_HANDLE_VALUE) {
		WriteFile(file, t.s, (DWORD)t.n, &wrote, NULL);
		CloseHandle(file);
	}
	if (t.s) SecureZeroMemory(t.s, t.n);
	free(t.s);
}

/* The WebSocket URL of an address: "host:port" -> "ws://host:port/api/ws". */
static void ws_url(const Settings *s, wchar_t *out, size_t len) {
	wchar_t address[512], *path;
	copy_str(address, 512, s->address);
	squeeze(address);
	if (!_wcsnicmp(address, L"http://", 7)) _snwprintf(out, len, L"ws://%ls", address + 7);
	else if (!_wcsnicmp(address, L"https://", 8)) _snwprintf(out, len, L"wss://%ls", address + 8);
	else if (wcsstr(address, L"://")) copy_str(out, len, address);
	else _snwprintf(out, len, L"ws://%ls", address);
	out[len - 1] = L'\0';
	/* no path = the API's */
	path = wcschr(wcsstr(out, L"://") + 3, L'/');
	if (!path || !path[1]) {
		if (path) *path = L'\0';
		wcsncat(out, L"/api/ws", len - wcslen(out) - 1);
	}
	if (s->key[0]) url_param(out, len, L"token", s->key);
}

/* ------------------------------------------------------------ the WebSocket */

typedef enum { WS_IDLE, WS_CONNECTING, WS_CONNECTED, WS_NEEDKEY, WS_BADKEY, WS_DOWN, WS_UNSUPPORTED } WsState;

static CRITICAL_SECTION g_wsLock;
static WebSocket g_ws;
static BOOL g_wsOpen; /* g_ws may be sent to */
static volatile LONG g_wsFresh; /* a new connection: the engine sends everything again */
static volatile LONG g_wsAgain; /* the settings changed: connect anew */

/* What the window shows; the engine writes it, under g_viewLock. */
typedef struct {
	int player; /* 0 = no media controls, 1 = Spotify is not open, 2 = paused, 3 = playing */
	wchar_t artist[256], title[256];
	wchar_t cur[512], next[512];
	BOOL searching, nothing;
	int variant, variants; /* 1-based, of how many */
	wchar_t sources[64];
	int votes;
	BOOL words;
	int lines;
	int offset;
	WsState ws;
	wchar_t wsText[200];
} View;

static CRITICAL_SECTION g_viewLock;
static View g_view; /* the engine's, copied under the lock */
static View g_shown; /* the window's */

static void view_ws(WsState state, const wchar_t *text) {
	EnterCriticalSection(&g_viewLock);
	g_view.ws = state;
	copy_str(g_view.wsText, 200, text);
	LeaveCriticalSection(&g_viewLock);
	if (g_main) PostMessageW(g_main, WM_APP_VIEW, 0, 0);
}

/* Sends a frame to notGT if there is a connection; FALSE when there is not. */
static BOOL ws_frame(const char *frame) {
	BOOL sent = FALSE;
	EnterCriticalSection(&g_wsLock);
	if (g_wsOpen) {
		sent = ws_send(&g_ws, frame);
		if (!sent) g_wsOpen = FALSE;
	}
	LeaveCriticalSection(&g_wsLock);
	return sent;
}

/* Keeps the connection to notGT: connects, reads what notGT says (who we are,
 * a refused key), and connects again when it drops or the settings change. */
static DWORD WINAPI ws_thread(LPVOID unused) {
	HANDLE wake[2];
	(void)unused;
	wake[0] = g_quit;
	wake[1] = g_wsWake;
	if (!ws_supported()) {
		view_ws(WS_UNSUPPORTED, L"");
		return 0;
	}
	for (;;) {
		Settings s;
		wchar_t url[1200], endText[200] = L"";
		DWORD status = 0, wait = 3000;
		WebSocket ws;
		WsState ended = WS_DOWN;
		USHORT closeCode = 0;
		BOOL hadKey;

		if (WaitForSingleObject(g_quit, 0) == WAIT_OBJECT_0) return 0;
		InterlockedExchange(&g_wsAgain, 0);
		EnterCriticalSection(&g_settingsLock);
		s = g_settings;
		LeaveCriticalSection(&g_settingsLock);
		if (!s.address[0]) {
			view_ws(WS_IDLE, L"");
			if (WaitForMultipleObjects(2, wake, FALSE, INFINITE) == WAIT_OBJECT_0) return 0;
			continue;
		}
		ws_url(&s, url, 1200);
		hadKey = s.key[0] != L'\0';
		SecureZeroMemory(&s, sizeof(s));
		view_ws(WS_CONNECTING, L"");
		if (!ws_open(&ws, url, &status)) {
			if (status)
				_snwprintf(endText, 200,
					T(L"По этому адресу ответили %lu, а не WebSocket notGT — проверьте адрес.",
						L"This address answered %lu, not with notGT's WebSocket: check it."),
					(unsigned long)status);
			view_ws(WS_DOWN, endText);
		} else {
			EnterCriticalSection(&g_wsLock);
			g_ws = ws;
			g_wsOpen = TRUE;
			LeaveCriticalSection(&g_wsLock);
			InterlockedExchange(&g_wsFresh, 1);
			for (;;) {
				char *message = ws_receive(&ws, &closeCode);
				JVal *frame;
				const wchar_t *type;
				if (!message) break;
				frame = json_parse(message);
				free(message);
				type = json_str(frame, L"type");
				if (!wcscmp(type, L"hello")) {
					if (json_bool(frame, L"authRequired") && !json_bool(frame, L"authenticated")) {
						view_ws(WS_NEEDKEY, L"");
					} else {
						wchar_t text[200];
						_snwprintf(text, 200, L"notGT %ls", json_str(frame, L"version"));
						text[199] = L'\0';
						log_line(L"notGT: connected (%ls)", text);
						view_ws(WS_CONNECTED, text);
					}
				} else if (!wcscmp(type, L"error") && !wcscmp(json_str(frame, L"code"), L"unauthorized")) {
					ended = WS_BADKEY;
				} else if (!wcscmp(type, L"reply") && json_get(frame, L"ok") && !json_bool(frame, L"ok")) {
					log_line(L"notGT: %ls", json_str(json_get(frame, L"error"), L"message"));
				}
				json_free(frame);
			}
			EnterCriticalSection(&g_wsLock);
			g_wsOpen = FALSE;
			ZeroMemory(&g_ws, sizeof(g_ws));
			LeaveCriticalSection(&g_wsLock);
			ws_close(&ws);
			if (closeCode == 4401) ended = WS_BADKEY;
			/* Turned away with no key at all: one is needed, not another one. */
			if (ended == WS_BADKEY && !hadKey) ended = WS_NEEDKEY;
			if (ended == WS_BADKEY || ended == WS_NEEDKEY) {
				log_line(ended == WS_BADKEY ? L"notGT: the key was refused" : L"notGT: a key is needed");
				wait = 15000; /* it stays so until someone changes the key */
			} else {
				log_line(L"notGT: disconnected");
			}
			view_ws(ended, endText);
		}
		SecureZeroMemory(url, sizeof(url));
		if (g_wsAgain) continue;
		if (WaitForMultipleObjects(2, wake, FALSE, wait) == WAIT_OBJECT_0) return 0;
	}
}

/* The settings changed: drop the connection, the thread makes a new one. */
static void ws_reconnect(void) {
	InterlockedExchange(&g_wsAgain, 1);
	EnterCriticalSection(&g_wsLock);
	if (g_wsOpen) ws_shutdown(&g_ws);
	LeaveCriticalSection(&g_wsLock);
	SetEvent(g_wsWake);
}

/* --------------------------------------------------------------- the search */

typedef struct Result {
	unsigned generation;
	Variants variants;
	BOOL final, complete;
	struct Result *next;
} Result;

static CRITICAL_SECTION g_inboxLock;
static Result *g_inbox;

static void post_result(unsigned generation, const Variants *vs, BOOL final, BOOL complete) {
	Result *r = (Result *)calloc(1, sizeof(Result)), **tail;
	if (!r) return;
	r->generation = generation;
	r->variants = variants_copy(vs);
	r->final = final;
	r->complete = complete;
	EnterCriticalSection(&g_inboxLock);
	for (tail = &g_inbox; *tail; tail = &(*tail)->next) {
	}
	*tail = r;
	LeaveCriticalSection(&g_inboxLock);
	SetEvent(g_engineWake);
}

typedef struct {
	const wchar_t *name;
	Track track;
	wchar_t token[256];
	Variants found;
	int answered;
	BOOL counted;
} SourceJob;

static DWORD WINAPI source_thread(LPVOID param) {
	SourceJob *job = (SourceJob *)param;
	if (!wcscmp(job->name, L"lrclib")) job->answered = source_lrclib(&job->track, &job->found);
	else if (!wcscmp(job->name, L"netease")) job->answered = source_netease(&job->track, &job->found);
	else job->answered = source_musixmatch(&job->track, job->token, &job->found);
	return 0;
}

typedef struct {
	unsigned generation;
	Track track;
	wchar_t token[256];
} LookupJob;

/*
 * Asks every source at once. Each answer that passes the checks is posted as
 * it comes — playback starts with the fastest one and moves to a better one
 * while it plays — and the end of the search is posted once more, saying
 * whether every source answered (only then does "nothing" mean nothing).
 */
static DWORD WINAPI lookup_thread(LPVOID param) {
	LookupJob *job = (LookupJob *)param;
	SourceJob *jobs = (SourceJob *)calloc(3, sizeof(SourceJob));
	HANDLE threads[3];
	int n = 0, answered = 0, finished = 0;
	Variants found = { NULL, 0 };
	DWORD start = GetTickCount();
	const wchar_t *names[3] = { L"musixmatch", L"lrclib", L"netease" };

	for (int i = 0; jobs && i < 3; i++) {
		if (i == 0 && !job->token[0]) continue;
		jobs[n].name = names[i];
		jobs[n].track = job->track;
		copy_str(jobs[n].token, 256, job->token);
		threads[n] = CreateThread(NULL, 0, source_thread, &jobs[n], 0, NULL);
		if (threads[n]) n++;
	}
	while (finished < n) {
		DWORD spent = GetTickCount() - start, which;
		BOOL any = FALSE;
		if (spent >= 10000) break;
		which = WaitForMultipleObjects((DWORD)n, threads, FALSE, 10000 - spent);
		if (which >= WAIT_OBJECT_0 + (DWORD)n) break;
		/* every thread that is done and not yet counted */
		for (int i = 0; i < n; i++) {
			wchar_t why[160];
			Variants ok = { NULL, 0 };
			if (jobs[i].counted || WaitForSingleObject(threads[i], 0) != WAIT_OBJECT_0) continue;
			jobs[i].counted = TRUE;
			finished++;
			if (!jobs[i].answered) {
				log_line(L"  %ls failed: no answer", jobs[i].name);
				continue;
			}
			answered++;
			for (int v = 0; v < jobs[i].found.n; v++) {
				const wchar_t *bad = check_lyrics(jobs[i].found.items[v].ly, &job->track, why, 160);
				if (bad) log_line(L"  %ls rejected: %ls", jobs[i].name, bad);
				else
					variants_add(&ok, jobs[i].found.items[v].sources, lyrics_ref(jobs[i].found.items[v].ly),
						jobs[i].found.items[v].votes, jobs[i].found.items[v].artist);
			}
			if (!ok.n) continue;
			log_line(L"  %ls: %d variant%ls in %.1f s", jobs[i].name, ok.n, ok.n == 1 ? L"" : L"s", (GetTickCount() - start) / 1000.0);
			variants_merge(&found, &ok);
			rank_variants(&found);
			any = TRUE;
		}
		if (any) post_result(job->generation, &found, FALSE, FALSE);
	}
	if (finished < n) log_line(L"  some sources did not answer in 10 s");
	if (!found.n) log_line(L"  nothing suitable for: %ls - %ls (%d s)", job->track.artist, job->track.title, (int)job->track.durationS);
	post_result(job->generation, &found, TRUE, answered == n && finished == n);
	variants_free(&found);
	/* The late ones have their own timeouts; what they find is dropped. */
	for (int i = 0; i < n; i++) {
		WaitForSingleObject(threads[i], INFINITE);
		CloseHandle(threads[i]);
		variants_free(&jobs[i].found);
	}
	SecureZeroMemory(job->token, sizeof(job->token));
	free(jobs);
	free(job);
	return 0;
}

/* ------------------------------------------------------------------ engine */

/* Smooths the player's position. The reported position jitters by a few
 * hundred ms; following every reading would restart the line's fill all the
 * time. The clock keeps its own (wall time - position), nudges it slowly, and
 * jumps only on a real seek (two readings in a row far from it) or after a pause. */
typedef struct {
	BOOL hasAnchor;
	double anchor;
	int misses; /* readings in a row far from the clock */
	int playing; /* -1 = not known yet */
} Clock;

static void clock_reset(Clock *c) {
	c->hasAnchor = FALSE;
	c->anchor = 0;
	c->misses = 0;
	c->playing = -1;
}

static double clock_update(Clock *c, double pos, BOOL playing, double now) {
	double target = now - pos;
	if (!playing) {
		c->playing = 0;
		c->hasAnchor = FALSE;
		c->misses = 0;
		return pos;
	}
	if (!c->hasAnchor || c->playing == 0) {
		c->anchor = target;
		c->misses = 0;
		c->hasAnchor = TRUE;
	} else if (fabs(target - c->anchor) > 1500) {
		if (++c->misses >= 2) { /* a seek */
			c->anchor = target;
			c->misses = 0;
		}
	} else {
		c->misses = 0;
		c->anchor += (target - c->anchor) * 0.15;
	}
	c->playing = 1;
	return now - c->anchor;
}

static double now_ms(void) {
	static LARGE_INTEGER freq;
	LARGE_INTEGER t;
	if (!freq.QuadPart) QueryPerformanceFrequency(&freq);
	QueryPerformanceCounter(&t);
	return (double)t.QuadPart * 1000.0 / (double)freq.QuadPart;
}

/* Commands from the window, in order. */
static CRITICAL_SECTION g_cmdLock;
static int g_cmds[64], g_cmdCount;

static void command(int cmd) {
	EnterCriticalSection(&g_cmdLock);
	if (g_cmdCount < 64) g_cmds[g_cmdCount++] = cmd;
	LeaveCriticalSection(&g_cmdLock);
	SetEvent(g_engineWake);
}

/* Where the track comes from when it is not Spotify (tests, a demo). */
static enum { PLAYER_SMTC, PLAYER_SIMULATE, PLAYER_FAKE } g_playerKind = PLAYER_SMTC;
static wchar_t g_fakeArtist[256], g_fakeTitle[256];
static double g_fakeDuration, g_fakeFrom, g_started;

static const struct {
	int t;
	const wchar_t *ru, *en;
} DEMO[] = {
	{ 0, L"Это демо-режим караоке", L"This is the karaoke demo" },
	{ 3500, L"Строки меняются по таймкодам", L"Lines change on their timecodes" },
	{ 7000, L"А заливка идёт слева направо", L"And the fill runs left to right" },
	{ 10500, L"Пока играет музыка", L"While the music plays" },
	{ 14000, L"", L"" },
};
#define DEMO_END 17000

/* A track that was searched for in full and has nothing; asked again after 10 min. */
typedef struct {
	unsigned long long key;
	DWORD at;
} Nothing;

static unsigned long long track_key(const wchar_t *artist, const wchar_t *title) {
	unsigned long long h = 0xcbf29ce484222325ULL;
	for (const wchar_t *c = artist; *c; c++) h = (h ^ (unsigned)*c) * 0x100000001b3ULL;
	h = (h ^ 0xFFFF) * 0x100000001b3ULL;
	for (const wchar_t *c = title; *c; c++) h = (h ^ (unsigned)*c) * 0x100000001b3ULL;
	return h;
}

/* The playing track and what the engine knows of it. Only the engine thread touches it. */
typedef struct {
	BOOL active;
	Track track;
	unsigned generation; /* of the search whose results count */
	Variants variants; /* best first */
	char pick[17]; /* the chosen variant */
	BOOL manual; /* chosen by hand */
	int offset; /* this track's own shift, ms */
	wchar_t cachePath[MAX_PATH];
	BOOL searching, nothing;
	char shown[17];
	Lyrics *ly; /* of the shown variant */
	int *sings;
	wchar_t artist[256]; /* every artist of the track, as far as the sources credit them */
} Current;

static Current g_cur;
static Nothing g_nothing[64];
static int g_nothingCount;
static unsigned g_generation;

static int shown_index(void) {
	for (int i = 0; i < g_cur.variants.n; i++)
		if (!strcmp(g_cur.variants.items[i].id, g_cur.shown)) return i;
	return -1;
}

static void show_variant(const Variant *v) {
	lyrics_unref(g_cur.ly);
	free(g_cur.sings);
	g_cur.ly = v ? lyrics_ref(v->ly) : NULL;
	g_cur.sings = v ? sing_times(v->ly) : NULL;
	strcpy(g_cur.shown, v ? v->id : "");
	strcpy(g_cur.pick, v ? v->id : "");
}

static void save_current(void) {
	if (g_cur.cachePath[0]) cache_save(g_cur.cachePath, &g_cur.variants, g_cur.pick, g_cur.manual, g_cur.offset);
}

/* The variants into the journal, with the shift of each against the shown one. */
static void describe(void) {
	int at = shown_index();
	if (g_cur.variants.n < 2 || at < 0) return;
	log_line(L"  %d variants:", g_cur.variants.n);
	for (int i = 0; i < g_cur.variants.n; i++) {
		const Variant *v = &g_cur.variants.items[i];
		wchar_t shift[40] = L"", votes[16] = L"";
		int s;
		if (i != at) {
			if (line_shift(g_cur.variants.items[at].ly, v->ly, &s)) _snwprintf(shift, 40, L", %+d ms", s);
			else copy_str(shift, 40, L", other text");
		}
		if (v->votes > 1) _snwprintf(votes, 16, L" x%d", v->votes);
		log_line(L"  %lc %d. %ls%ls, %d lines%ls%ls", i == at ? L'>' : L' ', i + 1, v->sources, votes, v->ly->n,
			v->ly->words ? L", word timing" : L"", shift);
	}
}

static void clear_current(void) {
	show_variant(NULL);
	variants_free(&g_cur.variants);
	ZeroMemory(&g_cur, sizeof(g_cur));
}

/* What arrived from a search (see lookup_thread). */
static void apply_result(const Result *r) {
	const Variant *best;
	if (r->generation != g_cur.generation || !g_cur.active) return;
	if (r->final) g_cur.searching = FALSE;
	if (r->final && !r->variants.n) {
		if (r->complete) {
			Nothing *slot = &g_nothing[g_nothingCount++ % 64];
			slot->key = track_key(g_cur.track.artist, g_cur.track.title);
			slot->at = GetTickCount();
			if (!g_cur.ly) g_cur.nothing = TRUE;
		} else {
			log_line(L"  a source did not answer; \"search again\" asks once more");
		}
	}
	if (!r->variants.n) return; /* a search again that found nothing keeps what is shown */
	variants_free(&g_cur.variants);
	g_cur.variants = variants_copy(&r->variants);
	g_cur.nothing = FALSE;
	{
		wchar_t artist[256];
		credited_artists(&g_cur.track, &g_cur.variants, artist, 256);
		if (wcscmp(artist, g_cur.artist)) {
			if (wcscmp(artist, g_cur.track.artist)) log_line(L"  artists: %ls", artist);
			copy_str(g_cur.artist, 256, artist);
		}
	}
	best = &g_cur.variants.items[0];
	if (g_cur.manual)
		for (int i = 0; i < g_cur.variants.n; i++)
			if (!strcmp(g_cur.variants.items[i].id, g_cur.pick)) best = &g_cur.variants.items[i];
	if (strcmp(best->id, g_cur.shown)) {
		show_variant(best);
		log_line(L"lyrics: %d lines%ls [%ls]", best->ly->n, best->ly->words ? L", with word timing" : L"", best->sources);
	}
	if (r->final) {
		describe();
		save_current();
	}
}

/* Lyrics for the playing track: from the cache, else from every source in the background. */
static void start_search(BOOL fresh) {
	LookupJob *job;
	Remembered remembered;
	HANDLE thread;
	if (!fresh && cache_load(g_cur.cachePath, &remembered)) {
		Result r = { 0 };
		r.generation = g_cur.generation = ++g_generation;
		r.variants = remembered.variants;
		r.final = r.complete = TRUE;
		strcpy(g_cur.pick, remembered.pick);
		g_cur.manual = remembered.manual;
		g_cur.offset = remembered.offset;
		log_line(L"  source: cache");
		apply_result(&r);
		variants_free(&remembered.variants);
		return;
	}
	if (!fresh) {
		unsigned long long key = track_key(g_cur.track.artist, g_cur.track.title);
		for (int i = 0; i < 64 && i < g_nothingCount; i++) {
			if (g_nothing[i].key == key && GetTickCount() - g_nothing[i].at < 600000) {
				log_line(L"  nothing found a moment ago (\"search again\" asks once more)");
				g_cur.nothing = TRUE;
				return;
			}
		}
	}
	job = (LookupJob *)calloc(1, sizeof(LookupJob));
	if (!job) return;
	job->generation = g_cur.generation = ++g_generation;
	job->track = g_cur.track;
	EnterCriticalSection(&g_settingsLock);
	copy_str(job->token, 256, g_settings.mxm);
	LeaveCriticalSection(&g_settingsLock);
	g_cur.searching = TRUE;
	g_cur.nothing = FALSE;
	thread = CreateThread(NULL, 0, lookup_thread, job, 0, NULL);
	if (thread) CloseHandle(thread);
	else free(job);
}

/* "s:e,s:e,..." per word, ms from the line's start, when the source has word timing. */
static void word_timing(const Line *line, int dur, Text *out) {
	for (int i = 0; line->words && i < line->nwords; i++) {
		int o = line->words[i].off, e = i + 1 < line->nwords ? line->words[i + 1].off : (dur < o + 1200 ? dur : o + 1200);
		text_printf(out, "%s%d:%d", i ? "," : "", o, e - 40 > o + 80 ? e - 40 : o + 80);
	}
}

static const wchar_t *line_text(int i) {
	return g_cur.ly && i >= 0 && i < g_cur.ly->n ? g_cur.ly->lines[i].text : L"";
}

static void push_frame(const PlayerState *st, int idx, double pos, unsigned seq) {
	Text t = { 0 }, wt = { 0 };
	int start = idx >= 0 ? g_cur.ly->lines[idx].t : 0;
	int end = g_cur.ly && idx + 1 < g_cur.ly->n ? g_cur.ly->lines[idx + 1].t : start + 4000;
	int dur = end - start, sing = g_cur.ly && idx >= 0 ? g_cur.sings[idx] : dur;
	text_raw(&t, "{\"type\":\"setData\",\"mode\":\"merge\",\"data\":{\"karaoke\":{\"artist\":");
	text_str(&t, g_cur.artist[0] ? g_cur.artist : st->artist);
	text_raw(&t, ",\"title\":");
	text_str(&t, st->title);
	text_raw(&t, ",\"prev\":");
	text_str(&t, line_text(idx - 1));
	text_raw(&t, ",\"cur\":");
	text_str(&t, line_text(idx));
	text_raw(&t, ",\"next\":");
	text_str(&t, line_text(idx + 1));
	text_raw(&t, ",\"next2\":");
	text_str(&t, line_text(idx + 2));
	if (idx >= 0) word_timing(&g_cur.ly->lines[idx], dur, &wt);
	text_printf(&t, ",\"dur\":\"%d\",\"sing\":\"%d\",\"pos\":\"%d\",\"playing\":\"%d\",\"seq\":\"%u\",\"wt\":", dur, sing,
		(int)(pos - start > 0 ? pos - start : 0), st->playing ? 1 : 0, seq);
	text_raw(&t, "\"");
	if (wt.s) text_raw(&t, wt.s);
	text_raw(&t, "\"}}}");
	if (t.s) ws_frame(t.s);
	free(t.s);
	free(wt.s);
}

static void push_empty(unsigned seq) {
	char frame[300];
	snprintf(frame, sizeof(frame),
		"{\"type\":\"setData\",\"mode\":\"merge\",\"data\":{\"karaoke\":{\"artist\":\"\",\"title\":\"\",\"prev\":\"\",\"cur\":\"\","
		"\"next\":\"\",\"next2\":\"\",\"wt\":\"\",\"playing\":\"0\",\"seq\":\"%u\"}}}",
		seq);
	ws_frame(frame);
}

/* Reads the player: Spotify through the media controls, or a stand-in. */
static BOOL read_player(BOOL smtcOk, PlayerState *st) {
	double el = now_ms() - g_started;
	ZeroMemory(st, sizeof(*st));
	if (g_playerKind == PLAYER_SIMULATE) {
		st->found = TRUE;
		copy_str(st->artist, 256, L"Demo");
		copy_str(st->title, 256, T(L"Караоке-тест", L"Karaoke test"));
		st->posMs = fmod(el, DEMO_END);
		st->durationS = DEMO_END / 1000.0;
		st->playing = TRUE;
		return TRUE;
	}
	if (g_playerKind == PLAYER_FAKE) {
		st->found = TRUE;
		copy_str(st->artist, 256, g_fakeArtist);
		copy_str(st->title, 256, g_fakeTitle);
		st->posMs = g_fakeFrom * 1000 + el;
		st->durationS = g_fakeDuration;
		st->playing = st->posMs < g_fakeDuration * 1000;
		if (!st->playing) st->posMs = g_fakeDuration * 1000;
		return TRUE;
	}
	return smtcOk && smtc_read(L"spotify", st);
}

static void demo_lyrics(void) {
	Lyrics *ly = lyrics_new();
	Variants demo = { NULL, 0 };
	Result r = { 0 };
	for (size_t i = 0; ly && i < sizeof(DEMO) / sizeof(DEMO[0]); i++) lyrics_add(ly, DEMO[i].t, wdup(T(DEMO[i].ru, DEMO[i].en)), NULL, 0);
	variants_add(&demo, L"demo", ly, 1, L"");
	r.generation = g_cur.generation = ++g_generation;
	r.variants = demo;
	r.final = r.complete = TRUE;
	apply_result(&r);
	variants_free(&demo);
}

/* The engine: reads the player, finds the lyrics, works out the line, tells
 * notGT and the window. One thread, every 120 ms (sooner when woken). */
static DWORD WINAPI engine_thread(LPVOID unused) {
	wchar_t why[64] = L"";
	BOOL smtcOk = g_playerKind != PLAYER_SMTC || smtc_init(why, 64);
	Clock clock;
	PlayerState st, last;
	double lastRead = -1e9, sentPos = 0, sentAt = 0;
	unsigned seq = 0;
	BOOL sentValid = FALSE, sentPlaying = FALSE, hadTrack = FALSE;
	int sentIdx = -2;
	(void)unused;

	if (!smtcOk) log_line(L"Windows media controls are not available (%ls): Spotify cannot be read", why);
	clock_reset(&clock);
	ZeroMemory(&last, sizeof(last));
	for (;;) {
		HANDLE wake[2] = { g_quit, g_engineWake };
		double now, pos;
		View v;
		int idx = -1;
		if (WaitForMultipleObjects(2, wake, FALSE, 120) == WAIT_OBJECT_0) break;
		now = now_ms();

		/* The player is asked twice a second; in between its position runs on. */
		if (now - lastRead >= 500) {
			if (!read_player(smtcOk, &last)) ZeroMemory(&last, sizeof(last));
			lastRead = now;
		}
		st = last;
		if (st.playing) st.posMs += now - lastRead;

		/* searches that finished */
		for (;;) {
			Result *r;
			EnterCriticalSection(&g_inboxLock);
			r = g_inbox;
			if (r) g_inbox = r->next;
			LeaveCriticalSection(&g_inboxLock);
			if (!r) break;
			apply_result(r);
			variants_free(&r->variants);
			free(r);
			sentValid = FALSE; /* the lyrics or the artists may have changed */
		}

		if (!st.found || !st.title[0]) {
			EnterCriticalSection(&g_cmdLock);
			g_cmdCount = 0;
			LeaveCriticalSection(&g_cmdLock);
			if (hadTrack) {
				clear_current();
				push_empty(++seq);
				hadTrack = FALSE;
			}
		} else {
			if (!g_cur.active || wcscmp(g_cur.track.artist, st.artist) || wcscmp(g_cur.track.title, st.title)) {
				/* A new track is announced at once (no lyrics of the last one), and searched for in the background. */
				clear_current();
				g_cur.active = TRUE;
				hadTrack = TRUE;
				track_init(&g_cur.track, st.artist, st.title, st.durationS);
				copy_str(g_cur.artist, 256, st.artist);
				clock_reset(&clock);
				sentValid = FALSE;
				log_line(L"%ls - %ls", st.artist, st.title);
				if (g_playerKind == PLAYER_SIMULATE) {
					demo_lyrics();
				} else {
					cache_path(g_cacheDir, &g_cur.track, g_cur.cachePath, MAX_PATH);
					start_search(FALSE);
				}
			}

			/* what the window and the tray asked for */
			for (;;) {
				int cmd = 0, at;
				EnterCriticalSection(&g_cmdLock);
				if (g_cmdCount) {
					cmd = g_cmds[0];
					memmove(g_cmds, g_cmds + 1, (size_t)--g_cmdCount * sizeof(int));
				}
				LeaveCriticalSection(&g_cmdLock);
				if (!cmd) break;
				at = shown_index();
				if ((cmd == CMD_NEXT || cmd == CMD_PREV) && g_cur.variants.n > 1) {
					at = (at + (cmd == CMD_NEXT ? 1 : g_cur.variants.n - 1)) % g_cur.variants.n;
					show_variant(&g_cur.variants.items[at]);
					g_cur.manual = TRUE;
					sentValid = FALSE;
					save_current();
					describe();
				} else if ((cmd == CMD_LATER || cmd == CMD_EARLIER || cmd == CMD_RESET) && g_cur.ly) {
					g_cur.offset = cmd == CMD_RESET ? 0 : g_cur.offset + (cmd == CMD_LATER ? 100 : -100);
					sentValid = FALSE;
					save_current();
					log_line(L"offset for this track: %+d ms", g_cur.offset);
				} else if (cmd == CMD_SEARCH && g_playerKind != PLAYER_SIMULATE) {
					log_line(L"searching again: %ls - %ls", g_cur.track.artist, g_cur.track.title);
					start_search(TRUE);
				}
			}

			pos = clock_update(&clock, st.posMs, st.playing, now) + g_cur.offset;
			for (int i = 0; g_cur.ly && i < g_cur.ly->n && g_cur.ly->lines[i].t <= pos; i++) idx = i;
			if (InterlockedExchange(&g_wsFresh, 0)) sentValid = FALSE;
			{
				double drift = sentValid ? fabs(sentPos + (now - sentAt) * (sentPlaying ? 1 : 0) - pos) : 0;
				if (!sentValid || idx != sentIdx || st.playing != sentPlaying || drift > 350) {
					push_frame(&st, idx, pos, ++seq);
					sentValid = TRUE;
					sentIdx = idx;
					sentPos = pos;
					sentAt = now;
					sentPlaying = st.playing;
				}
			}
		}

		/* what the window shows */
		ZeroMemory(&v, sizeof(v));
		v.player = !smtcOk ? 0 : !st.found ? 1 : st.playing ? 3 : 2;
		if (st.found && st.title[0]) {
			int at = shown_index();
			copy_str(v.artist, 256, g_cur.artist[0] ? g_cur.artist : st.artist);
			copy_str(v.title, 256, st.title);
			copy_str(v.cur, 512, line_text(idx));
			copy_str(v.next, 512, line_text(idx + 1));
			v.searching = g_cur.searching;
			v.nothing = g_cur.nothing && !g_cur.ly;
			v.variants = g_cur.variants.n;
			v.variant = at + 1;
			if (at >= 0) {
				copy_str(v.sources, 64, g_cur.variants.items[at].sources);
				v.votes = g_cur.variants.items[at].votes;
				v.words = g_cur.variants.items[at].ly->words;
				v.lines = g_cur.variants.items[at].ly->n;
			}
			v.offset = g_cur.offset;
		}
		EnterCriticalSection(&g_viewLock);
		v.ws = g_view.ws;
		memcpy(v.wsText, g_view.wsText, sizeof(v.wsText));
		if (memcmp(&v, &g_view, sizeof(v))) {
			g_view = v;
			if (g_main) PostMessageW(g_main, WM_APP_VIEW, 0, 0);
		}
		LeaveCriticalSection(&g_viewLock);
	}
	/* Leaving: the title is told that nothing plays any more. */
	if (hadTrack) push_empty(++seq);
	clear_current();
	return 0;
}

/* ----------------------------------------------------------------- drawing */
/* The launcher's helpers (launcher/win/notGT-launcher.c), for the same look. */

typedef struct {
	UINT32 GdiplusVersion;
	void *DebugEventCallback;
	BOOL SuppressBackgroundThread;
	BOOL SuppressExternalCodecs;
} GdiplusStartupInput;
int WINAPI GdiplusStartup(ULONG_PTR *token, const GdiplusStartupInput *input, void *output);
int WINAPI GdipCreateBitmapFromStream(IStream *stream, void **bitmap);
int WINAPI GdipCreateHBITMAPFromBitmap(void *bitmap, HBITMAP *hbm, DWORD background);
int WINAPI GdipGetImageWidth(void *image, UINT *width);
int WINAPI GdipGetImageHeight(void *image, UINT *height);
int WINAPI GdipDisposeImage(void *image);

static void load_logo(void) {
	HRSRC res = FindResourceW(g_instance, L"LOGO", (LPCWSTR)RT_RCDATA);
	HGLOBAL data = res ? LoadResource(g_instance, res) : NULL;
	DWORD size = res ? SizeofResource(g_instance, res) : 0;
	HGLOBAL copy;
	IStream *stream = NULL;
	ULONG_PTR token = 0;
	GdiplusStartupInput input = { 1, NULL, FALSE, FALSE };
	void *bitmap = NULL;
	if (!data || !size) return;
	copy = GlobalAlloc(GMEM_MOVEABLE, size);
	if (!copy) return;
	memcpy(GlobalLock(copy), LockResource(data), size);
	GlobalUnlock(copy);
	if (CreateStreamOnHGlobal(copy, TRUE, &stream) != S_OK) {
		GlobalFree(copy);
		return;
	}
	if (GdiplusStartup(&token, &input, NULL) == 0 && GdipCreateBitmapFromStream(stream, &bitmap) == 0) {
		UINT w = 0, h = 0;
		GdipGetImageWidth(bitmap, &w);
		GdipGetImageHeight(bitmap, &h);
		if (GdipCreateHBITMAPFromBitmap(bitmap, &g_logo, 0xFF0C2B25) == 0) {
			g_logoW = (int)w;
			g_logoH = (int)h;
		}
		GdipDisposeImage(bitmap);
	}
	stream->lpVtbl->Release(stream);
}

static HFONT make_font(int px, int weight, const wchar_t *face) {
	return CreateFontW(-S(px), 0, 0, 0, weight, FALSE, FALSE, FALSE, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS,
		CLIP_DEFAULT_PRECIS, CLEARTYPE_QUALITY, DEFAULT_PITCH | FF_DONTCARE, face);
}

static void fill(HDC dc, const RECT *r, COLORREF color) {
	SetDCBrushColor(dc, color);
	FillRect(dc, r, (HBRUSH)GetStockObject(DC_BRUSH));
}

static void fill_round(HDC dc, const RECT *r, int radius, COLORREF color, COLORREF ground) {
	enum { K = 4 };
	int w = r->right - r->left, h = r->bottom - r->top;
	HDC big;
	HBITMAP bitmap, old;
	RECT all = { 0, 0, w * K, h * K };
	if (w <= 0 || h <= 0) return;
	big = CreateCompatibleDC(dc);
	bitmap = CreateCompatibleBitmap(dc, w * K, h * K);
	old = (HBITMAP)SelectObject(big, bitmap);
	fill(big, &all, ground);
	SelectObject(big, GetStockObject(DC_BRUSH));
	SelectObject(big, GetStockObject(NULL_PEN));
	SetDCBrushColor(big, color);
	RoundRect(big, 0, 0, w * K + 1, h * K + 1, radius * 2 * K, radius * 2 * K);
	SetStretchBltMode(dc, HALFTONE);
	SetBrushOrgEx(dc, 0, 0, NULL);
	StretchBlt(dc, r->left, r->top, w, h, big, 0, 0, w * K, h * K, SRCCOPY);
	SelectObject(big, old);
	DeleteObject(bitmap);
	DeleteDC(big);
}

static void text(HDC dc, const wchar_t *s, RECT r, HFONT font, COLORREF color, UINT format) {
	HFONT old = (HFONT)SelectObject(dc, font);
	int saved = 0;
	SetBkMode(dc, TRANSPARENT);
	SetTextColor(dc, color);
	if (format & DT_WORDBREAK) {
		saved = SaveDC(dc);
		IntersectClipRect(dc, r.left, r.top, r.right + S(10), r.bottom);
		format |= DT_NOCLIP;
	}
	DrawTextW(dc, s, -1, &r, format | DT_NOPREFIX);
	if (saved) RestoreDC(dc, saved);
	SelectObject(dc, old);
}

static void card(HDC dc, int x, int y, int w, int h) {
	RECT r = R(x, y, w, h);
	fill_round(dc, &r, S(10), C_CARD, C_BG);
}

static void well(HDC dc, int x, int y, int w, int h, COLORREF ground) {
	RECT r = R(x, y, w, h);
	fill_round(dc, &r, S(6), C_LINE, ground);
	InflateRect(&r, -S(1), -S(1));
	fill_round(dc, &r, S(5), C_WELL, C_LINE);
}

static void caps(HDC dc, const wchar_t *s, int x, int y) {
	text(dc, s, R(x, y, 400, 16), g_fontCaps, C_MUTED, DT_LEFT | DT_SINGLELINE);
}

/* A status pill on a card: a coloured dot and a word. */
static void pill(HDC dc, int x, int y, const wchar_t *label, COLORREF dotColor) {
	SIZE size;
	HFONT old = (HFONT)SelectObject(dc, g_fontBold);
	RECT r, dot;
	GetTextExtentPoint32W(dc, label, (int)wcslen(label), &size);
	SelectObject(dc, old);
	r = R(x, y, 0, 24);
	r.right = r.left + S(30) + size.cx + S(12);
	fill_round(dc, &r, S(12), C_CONTROL, C_CARD);
	dot = R(x + 10, y + 8, 8, 8);
	fill_round(dc, &dot, S(4), dotColor, C_CONTROL);
	r.left += S(26);
	text(dc, label, r, g_fontBold, C_TEXT, DT_LEFT | DT_VCENTER | DT_SINGLELINE);
}

static LRESULT CALLBACK button_proc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp, UINT_PTR id, DWORD_PTR ref) {
	(void)id;
	(void)ref;
	switch (msg) {
	case WM_MOUSEMOVE:
		if (!GetPropW(hwnd, L"hot")) {
			TRACKMOUSEEVENT track = { sizeof(track), TME_LEAVE, hwnd, 0 };
			TrackMouseEvent(&track);
			SetPropW(hwnd, L"hot", (HANDLE)1);
			InvalidateRect(hwnd, NULL, FALSE);
		}
		break;
	case WM_MOUSELEAVE:
		RemovePropW(hwnd, L"hot");
		InvalidateRect(hwnd, NULL, FALSE);
		break;
	case WM_ERASEBKGND:
		return 1;
	case WM_NCDESTROY:
		RemovePropW(hwnd, L"hot");
		break;
	}
	return DefSubclassProc(hwnd, msg, wp, lp);
}

static HWND make_button(HWND parent, int id, const wchar_t *label, int kind, int x, int y, int w, int h) {
	HWND hwnd = CreateWindowExW(0, L"BUTTON", label, WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_OWNERDRAW, S(x), S(y),
		S(w), S(h), parent, (HMENU)(INT_PTR)id, g_instance, NULL);
	SetWindowLongPtrW(hwnd, GWLP_USERDATA, kind);
	SetWindowSubclass(hwnd, button_proc, 1, 0);
	return hwnd;
}

static void draw_button(const DRAWITEMSTRUCT *item, COLORREF ground) {
	int kind = (int)GetWindowLongPtrW(item->hwndItem, GWLP_USERDATA);
	BOOL disabled = (item->itemState & ODS_DISABLED) != 0;
	BOOL pressed = (item->itemState & ODS_SELECTED) != 0;
	BOOL hot = GetPropW(item->hwndItem, L"hot") != NULL && !disabled;
	COLORREF face = C_CONTROL, ink = C_TEXT;
	RECT r = item->rcItem;
	wchar_t label[200];
	HDC dc = item->hDC;

	GetWindowTextW(item->hwndItem, label, 200);
	fill(dc, &r, ground);
	if (kind == BTN_PRIMARY) {
		face = disabled ? C_CONTROL : hot || pressed ? C_SIGNAL_HOT : C_SIGNAL;
		ink = disabled ? C_FAINT : C_BG;
	} else if (kind == BTN_GHOST) {
		face = hot || pressed ? C_CARD : ground;
		ink = disabled ? C_FAINT : hot ? C_TEXT : C_MUTED;
	} else if (kind == BTN_LANG) {
		BOOL current = (GetDlgCtrlID(item->hwndItem) == ID_LANG_EN) == (g_lang == 1);
		face = current ? C_CONTROL : hot ? C_CARD : ground;
		ink = current ? C_TEXT : C_MUTED;
	} else {
		face = hot || pressed ? C_CONTROL_HOT : C_CONTROL;
		ink = disabled ? C_FAINT : C_TEXT;
	}
	if (face != ground) fill_round(dc, &r, S(6), face, ground);
	if (pressed) OffsetRect(&r, 0, S(1));
	text(dc, label, r, kind == BTN_GHOST ? g_font : kind == BTN_LANG ? g_fontCaps : g_fontBold, ink,
		DT_CENTER | DT_VCENTER | DT_SINGLELINE);
	if (item->itemState & ODS_FOCUS && !(item->itemState & ODS_NOFOCUSRECT)) {
		RECT focus = item->rcItem;
		HPEN pen = CreatePen(PS_SOLID, S(1), kind == BTN_PRIMARY ? C_TEXT : C_SIGNAL);
		HPEN oldPen = (HPEN)SelectObject(dc, pen);
		HBRUSH oldBrush = (HBRUSH)SelectObject(dc, GetStockObject(NULL_BRUSH));
		RoundRect(dc, focus.left, focus.top, focus.right, focus.bottom, S(12), S(12));
		SelectObject(dc, oldBrush);
		SelectObject(dc, oldPen);
		DeleteObject(pen);
	}
}

static HWND make_edit(HWND parent, int id, DWORD style, int x, int y, int w, int h, HFONT font) {
	HWND hwnd = CreateWindowExW(0, L"EDIT", L"", WS_CHILD | WS_VISIBLE | WS_TABSTOP | style, S(x), S(y), S(w), S(h),
		parent, (HMENU)(INT_PTR)id, g_instance, NULL);
	SendMessageW(hwnd, WM_SETFONT, (WPARAM)font, TRUE);
	return hwnd;
}

static LRESULT edit_colors(HDC dc) {
	SetTextColor(dc, C_TEXT);
	SetBkColor(dc, C_WELL);
	return (LRESULT)g_brushWell;
}

static void paint_buffered(HWND hwnd, void (*painter)(HWND, HDC)) {
	PAINTSTRUCT ps;
	HDC dc = BeginPaint(hwnd, &ps), mem = CreateCompatibleDC(dc);
	RECT client;
	HBITMAP bitmap, old;
	GetClientRect(hwnd, &client);
	bitmap = CreateCompatibleBitmap(dc, client.right, client.bottom);
	old = (HBITMAP)SelectObject(mem, bitmap);
	painter(hwnd, mem);
	BitBlt(dc, 0, 0, client.right, client.bottom, mem, 0, 0, SRCCOPY);
	SelectObject(mem, old);
	DeleteObject(bitmap);
	DeleteDC(mem);
	EndPaint(hwnd, &ps);
}

static void brand_title_bar(HWND hwnd) {
	HMODULE dwm = LoadLibraryW(L"dwmapi.dll");
	typedef HRESULT(WINAPI * SetAttribute)(HWND, DWORD, LPCVOID, DWORD);
	SetAttribute set = dwm ? (SetAttribute)(void *)GetProcAddress(dwm, "DwmSetWindowAttribute") : NULL;
	if (set) {
		BOOL dark = TRUE;
		COLORREF caption = C_BG, ink = C_TEXT;
		set(hwnd, 20, &dark, sizeof(dark));
		set(hwnd, 35, &caption, sizeof(caption));
		set(hwnd, 36, &ink, sizeof(ink));
	}
}

/* ------------------------------------------------------------- main window */

#define MAIN_W 480
#define MAIN_H 618

static const wchar_t *ws_label(COLORREF *color) {
	*color = C_SIGNAL;
	switch (g_shown.ws) {
	case WS_CONNECTED:
		*color = C_LEMON;
		return T(L"notGT подключён", L"notGT connected");
	case WS_CONNECTING:
		*color = C_AMBER;
		return T(L"подключение…", L"connecting…");
	case WS_NEEDKEY:
		return T(L"нужен ключ", L"a key is needed");
	case WS_BADKEY:
		return T(L"ключ не принят", L"key refused");
	case WS_DOWN:
		return T(L"нет связи", L"no connection");
	case WS_UNSUPPORTED:
		return T(L"не поддерживается", L"not supported");
	default:
		*color = C_FAINT;
		return T(L"нет адреса", L"no address");
	}
}

static const wchar_t *ws_detail(void) {
	switch (g_shown.ws) {
	case WS_CONNECTED:
		return g_shown.wsText;
	case WS_NEEDKEY:
		return T(L"notGT просит ключ: впишите его и нажмите «Подключить».", L"notGT asks for a key: type it and press “Connect”.");
	case WS_BADKEY:
		return T(L"Такого ключа нет в notGT. Ключи — в панели, вкладка «Команда».", L"notGT has no such key. The keys are in the dashboard, Team tab.");
	case WS_DOWN:
		if (g_shown.wsText[0]) return g_shown.wsText;
		return T(L"notGT не отвечает по этому адресу. Сервер запущен?", L"notGT does not answer at this address. Is the server running?");
	case WS_UNSUPPORTED:
		return T(L"Для связи с notGT нужен Windows 8 или новее.", L"Windows 8 or later is needed to reach notGT.");
	default:
		return L"";
	}
}

static void paint_main(HWND hwnd, HDC dc) {
	RECT all = R(0, 0, MAIN_W, MAIN_H);
	wchar_t line[1200];
	COLORREF color;
	(void)hwnd;
	fill(dc, &all, C_BG);

	/* header: the logo with "lyrics bridge" after it, the language */
	{
		int after = S(20) + S(110);
		if (g_logo) {
			HDC src = CreateCompatibleDC(dc);
			HBITMAP old = (HBITMAP)SelectObject(src, g_logo);
			int h = S(44), w = MulDiv(h, g_logoW, g_logoH);
			SetStretchBltMode(dc, HALFTONE);
			SetBrushOrgEx(dc, 0, 0, NULL);
			StretchBlt(dc, S(20), S(18), w, h, src, 0, 0, g_logoW, g_logoH, SRCCOPY);
			SelectObject(src, old);
			DeleteDC(src);
			after = S(20) + w;
		} else {
			text(dc, L"notGT", R(20, 18, 200, 44), g_fontBold, C_TEXT, DT_LEFT | DT_VCENTER | DT_SINGLELINE);
		}
		{
			RECT r = R(0, 18, 0, 44);
			r.left = after + S(10);
			r.right = S(370);
			text(dc, L"lyrics bridge", r, g_fontBold, C_MUTED, DT_LEFT | DT_VCENTER | DT_SINGLELINE);
		}
	}

	/* notGT: the address, the key, the connection */
	card(dc, 20, 78, 440, 152);
	caps(dc, T(L"АДРЕС NOTGT", L"NOTGT ADDRESS"), 34, 90);
	well(dc, 34, 108, 200, 34, C_CARD);
	caps(dc, T(L"КЛЮЧ WEBSOCKET", L"WEBSOCKET KEY"), 246, 90);
	well(dc, 246, 108, 200, 34, C_CARD);
	{
		const wchar_t *label = ws_label(&color);
		pill(dc, 34, 158, label, color);
	}
	text(dc, ws_detail(), R(34, 188, 290, 36), g_fontSmall, g_shown.ws == WS_CONNECTED ? C_MUTED : C_AMBER,
		DT_LEFT | DT_WORDBREAK | DT_END_ELLIPSIS | DT_EDITCONTROL);

	/* what plays and what is sung */
	card(dc, 20, 242, 440, 170);
	pill(dc, 34, 254,
		g_shown.player == 0	  ? T(L"Spotify недоступен", L"Spotify unavailable")
		: g_shown.player == 1 ? T(L"Spotify не запущен", L"Spotify is not open")
		: g_shown.player == 2 ? T(L"пауза", L"paused")
							  : T(L"играет", L"playing"),
		g_shown.player == 3 ? C_LEMON : g_shown.player == 2 ? C_AMBER : C_FAINT);
	if (g_shown.player == 0) {
		text(dc,
			T(L"Не открылась медиа-панель Windows, через которую видно Spotify. Нужен Windows 10 (1809) или новее.",
				L"The Windows media controls Spotify reports to did not open. Windows 10 (1809) or later is needed."),
			R(34, 288, 412, 60), g_font, C_MUTED, DT_LEFT | DT_WORDBREAK);
	} else if (!g_shown.title[0]) {
		text(dc, g_shown.player == 1 ? T(L"Откройте Spotify и включите трек.", L"Open Spotify and play a track.")
									 : T(L"Ничего не играет.", L"Nothing is playing."),
			R(34, 288, 412, 40), g_font, C_MUTED, DT_LEFT | DT_WORDBREAK);
	} else {
		_snwprintf(line, 1200, L"%ls \x2014 %ls", g_shown.artist, g_shown.title);
		line[1199] = L'\0';
		text(dc, line, R(34, 286, 412, 20), g_fontBold, C_TEXT, DT_LEFT | DT_SINGLELINE | DT_END_ELLIPSIS);
		if (g_shown.lines) {
			text(dc, g_shown.cur[0] ? g_shown.cur : L"\x2026", R(34, 312, 412, 48), g_fontBig, C_TEXT,
				DT_LEFT | DT_WORDBREAK | DT_END_ELLIPSIS | DT_EDITCONTROL);
			text(dc, g_shown.next, R(34, 362, 412, 18), g_fontSmall, C_FAINT, DT_LEFT | DT_SINGLELINE | DT_END_ELLIPSIS);
		} else {
			text(dc,
				g_shown.searching ? T(L"Ищу текст…", L"Looking for the lyrics…")
				: g_shown.nothing ? T(L"Синхронизированный текст не найден. «Искать заново» спросит источники ещё раз.",
										L"No synced lyrics found. “Search again” asks the sources once more.")
								  : L"",
				R(34, 312, 412, 48), g_font, g_shown.nothing ? C_AMBER : C_MUTED, DT_LEFT | DT_WORDBREAK);
		}
		if (g_shown.variant > 0) {
			wchar_t votes[32] = L"";
			if (g_shown.votes > 1) _snwprintf(votes, 32, L" \x00d7%d", g_shown.votes);
			_snwprintf(line, 1200, T(L"%ls%ls%ls · вариант %d из %d · сдвиг %+d мс", L"%ls%ls%ls · variant %d of %d · shift %+d ms"),
				g_shown.sources, votes, g_shown.words ? T(L", по словам", L", word timing") : L"", g_shown.variant,
				g_shown.variants, g_shown.offset);
			line[1199] = L'\0';
			text(dc, line, R(34, 386, 412, 18), g_fontSmall, C_MUTED, DT_LEFT | DT_SINGLELINE | DT_END_ELLIPSIS);
		}
	}

	/* the controls */
	card(dc, 20, 424, 440, 136);
	caps(dc, T(L"ВАРИАНТ ТЕКСТА", L"LYRICS VARIANT"), 34, 436);
	caps(dc, T(L"СДВИГ ТЕКСТА ЭТОГО ТРЕКА", L"THIS TRACK'S TEXT SHIFT"), 34, 500);
}

static void update_tray(void);

/* The controls follow what the engine says. */
static void apply_view(void) {
	BOOL track = g_shown.title[0] != L'\0', lyrics = g_shown.lines > 0;
	EnableWindow(GetDlgItem(g_main, ID_PREV), g_shown.variants > 1);
	EnableWindow(GetDlgItem(g_main, ID_NEXT), g_shown.variants > 1);
	EnableWindow(GetDlgItem(g_main, ID_SEARCH), track && g_playerKind != PLAYER_SIMULATE && !g_shown.searching);
	EnableWindow(GetDlgItem(g_main, ID_EARLIER), lyrics);
	EnableWindow(GetDlgItem(g_main, ID_RESET), lyrics && g_shown.offset != 0);
	EnableWindow(GetDlgItem(g_main, ID_LATER), lyrics);
	InvalidateRect(g_main, NULL, FALSE);
	update_tray();
}

static void relabel(void) {
	SetWindowTextW(g_main, L"notGT Lyrics Bridge");
	SetDlgItemTextW(g_main, ID_CONNECT, T(L"Подключить", L"Connect"));
	SetDlgItemTextW(g_main, ID_PREV, T(L"\x2039 Предыдущий", L"\x2039 Previous"));
	SetDlgItemTextW(g_main, ID_NEXT, T(L"Следующий \x203a", L"Next \x203a"));
	SetDlgItemTextW(g_main, ID_SEARCH, T(L"Искать заново", L"Search again"));
	SetDlgItemTextW(g_main, ID_EARLIER, T(L"Раньше \x2212" L"100 мс", L"Earlier \x2212" L"100 ms"));
	SetDlgItemTextW(g_main, ID_RESET, T(L"Сбросить", L"Reset"));
	SetDlgItemTextW(g_main, ID_LATER, T(L"Позже +100 мс", L"Later +100 ms"));
	SetDlgItemTextW(g_main, ID_SHOW_MXM, L"Musixmatch\x2026");
	SetDlgItemTextW(g_main, ID_SHOW_LOG, T(L"Журнал\x2026", L"Journal\x2026"));
	InvalidateRect(g_main, NULL, TRUE);
	if (g_mxmWnd) {
		SetDlgItemTextW(g_mxmWnd, ID_MXM_SAVE, T(L"Сохранить", L"Save"));
		SetDlgItemTextW(g_mxmWnd, ID_MXM_CLEAR, T(L"Убрать токен", L"Remove the token"));
		InvalidateRect(g_mxmWnd, NULL, TRUE);
	}
	if (g_logWnd) SetWindowTextW(g_logWnd, T(L"Журнал Lyrics Bridge", L"Lyrics Bridge journal"));
}

static void show_window(HWND hwnd) {
	ShowWindow(hwnd, IsIconic(hwnd) ? SW_RESTORE : SW_SHOW);
	SetForegroundWindow(hwnd);
}

/* --------------------------------------------------------------------- tray */

static void update_tray(void) {
	wchar_t tip[128];
	if (g_snapshotDir[0]) return;
	if (g_shown.title[0]) _snwprintf(tip, 128, L"%ls \x2014 %ls", g_shown.artist, g_shown.title);
	else copy_str(tip, 128, L"notGT Lyrics Bridge");
	tip[127] = L'\0';
	if (!wcscmp(tip, g_tray.szTip)) return;
	copy_str(g_tray.szTip, 128, tip);
	g_tray.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
	Shell_NotifyIconW(NIM_MODIFY, &g_tray);
}

static void add_tray(void) {
	ZeroMemory(&g_tray, sizeof(g_tray));
	g_tray.cbSize = sizeof(g_tray);
	g_tray.hWnd = g_main;
	g_tray.uID = 1;
	g_tray.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
	g_tray.uCallbackMessage = WM_APP_TRAY;
	g_tray.hIcon = g_iconSmall;
	copy_str(g_tray.szTip, 128, L"notGT Lyrics Bridge");
	Shell_NotifyIconW(NIM_ADD, &g_tray);
}

/* Once per run, when the window is first closed: where the program went. */
static void tray_hint(void) {
	if (g_hintShown || g_snapshotDir[0]) return;
	g_hintShown = TRUE;
	g_tray.uFlags = NIF_INFO;
	copy_str(g_tray.szInfoTitle, 64, T(L"Lyrics Bridge работает дальше", L"Lyrics Bridge keeps running"));
	copy_str(g_tray.szInfo, 256,
		T(L"Окно скрыто. Управление и «Выйти» — в меню этого значка.", L"The window is hidden. The controls and “Quit” are in this icon's menu."));
	g_tray.dwInfoFlags = NIIF_INFO;
	Shell_NotifyIconW(NIM_MODIFY, &g_tray);
	g_tray.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
}

static void tray_menu(void) {
	HMENU menu = CreatePopupMenu();
	POINT at;
	wchar_t head[300];
	BOOL track = g_shown.title[0] != L'\0', lyrics = g_shown.lines > 0;
	UINT many = g_shown.variants > 1 ? 0 : MF_GRAYED;
	if (track) _snwprintf(head, 300, L"%ls \x2014 %ls", g_shown.artist, g_shown.title);
	else copy_str(head, 300, T(L"Ничего не играет", L"Nothing is playing"));
	head[299] = L'\0';
	AppendMenuW(menu, MF_STRING | MF_GRAYED, 0, head);
	AppendMenuW(menu, MF_SEPARATOR, 0, NULL);
	AppendMenuW(menu, MF_STRING | many, ID_NEXT, T(L"Следующий вариант текста", L"Next lyrics variant"));
	AppendMenuW(menu, MF_STRING | many, ID_PREV, T(L"Предыдущий вариант текста", L"Previous lyrics variant"));
	AppendMenuW(menu, MF_STRING | (lyrics ? 0 : MF_GRAYED), ID_LATER, T(L"Текст позже на 100 мс", L"Text 100 ms later"));
	AppendMenuW(menu, MF_STRING | (lyrics ? 0 : MF_GRAYED), ID_EARLIER, T(L"Текст раньше на 100 мс", L"Text 100 ms earlier"));
	AppendMenuW(menu, MF_STRING | (lyrics && g_shown.offset ? 0 : MF_GRAYED), ID_RESET, T(L"Сбросить сдвиг", L"Reset the shift"));
	AppendMenuW(menu, MF_STRING | (track && g_playerKind != PLAYER_SIMULATE && !g_shown.searching ? 0 : MF_GRAYED), ID_SEARCH,
		T(L"Искать текст заново", L"Search for the lyrics again"));
	AppendMenuW(menu, MF_SEPARATOR, 0, NULL);
	AppendMenuW(menu, MF_STRING, ID_TRAY_SHOW, T(L"Показать окно", L"Show the window"));
	AppendMenuW(menu, MF_STRING, ID_TRAY_QUIT, T(L"Выйти", L"Quit"));
	GetCursorPos(&at);
	SetForegroundWindow(g_main); /* or the menu would not close on a click elsewhere */
	TrackPopupMenu(menu, TPM_RIGHTBUTTON, at.x, at.y, 0, g_main, NULL);
	DestroyMenu(menu);
}

/* ------------------------------------------------------------ small windows */

static HWND open_tool_window(HWND *slot, const wchar_t *className, const wchar_t *title, int w, int h, DWORD style) {
	RECT frame = { 0, 0, S(w), S(h) }, owner;
	if (*slot) {
		show_window(*slot);
		return *slot;
	}
	AdjustWindowRectEx(&frame, style, FALSE, 0);
	GetWindowRect(g_main, &owner);
	*slot = CreateWindowExW(0, className, title, style, owner.left + S(24), owner.top + S(64), frame.right - frame.left,
		frame.bottom - frame.top, g_main, NULL, g_instance, NULL);
	brand_title_bar(*slot);
	ShowWindow(*slot, SW_SHOW);
	return *slot;
}

/* --- Musixmatch ------------------------------------------------------------ */

#define MXM_W 420
#define MXM_H 300

static wchar_t g_mxmMessage[300];

static void paint_mxm(HWND hwnd, HDC dc) {
	RECT all;
	BOOL has;
	GetClientRect(hwnd, &all);
	fill(dc, &all, C_BG);
	EnterCriticalSection(&g_settingsLock);
	has = g_settings.mxm[0] != L'\0';
	LeaveCriticalSection(&g_settingsLock);
	text(dc, has ? T(L"Токен задан: Musixmatch спрашивается первым.", L"A token is set: Musixmatch is asked first.")
				 : T(L"Токена нет: тексты ищутся в LRCLIB и NetEase.", L"No token: the lyrics come from LRCLIB and NetEase."),
		R(20, 16, 380, 20), g_fontBold, has ? C_LEMON : C_TEXT, DT_LEFT | DT_SINGLELINE);
	text(dc,
		T(L"Musixmatch — самая большая база, и именно её тексты показывает Spotify. Анонимно она их больше не отдаёт: "
		  L"нужен токен вашей учётной записи Musixmatch (usertoken). Он хранится зашифрованным для этого пользователя Windows.",
			L"Musixmatch is the largest catalogue, and the one whose lyrics Spotify shows. It no longer gives them out "
			L"anonymously: a token of your own Musixmatch account (usertoken) is needed. It is kept encrypted for this Windows user."),
		R(20, 44, 380, 90), g_fontSmall, C_MUTED, DT_LEFT | DT_WORDBREAK);
	caps(dc, T(L"ТОКЕН MUSIXMATCH", L"MUSIXMATCH TOKEN"), 20, 140);
	well(dc, 20, 158, 380, 34, C_BG);
	text(dc, g_mxmMessage, R(20, 254, 380, 36), g_fontSmall, C_LEMON, DT_LEFT | DT_WORDBREAK);
}

/* "Remove the token" only while there is one. */
static void update_mxm_window(void) {
	BOOL has;
	if (!g_mxmWnd) return;
	EnterCriticalSection(&g_settingsLock);
	has = g_settings.mxm[0] != L'\0';
	LeaveCriticalSection(&g_settingsLock);
	EnableWindow(GetDlgItem(g_mxmWnd, ID_MXM_CLEAR), has);
	InvalidateRect(g_mxmWnd, NULL, FALSE);
}

static LRESULT CALLBACK mxm_proc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
	switch (msg) {
	case WM_CREATE:
		make_edit(hwnd, ID_MXM_TOKEN, ES_AUTOHSCROLL | ES_PASSWORD, 30, 166, 360, 20, g_font);
		SendDlgItemMessageW(hwnd, ID_MXM_TOKEN, EM_SETLIMITTEXT, 200, 0);
		make_button(hwnd, ID_MXM_SAVE, L"", BTN_PRIMARY, 20, 206, 180, 36);
		make_button(hwnd, ID_MXM_CLEAR, L"", BTN_NORMAL, 208, 206, 192, 36);
		g_mxmMessage[0] = L'\0';
		g_mxmWnd = hwnd;
		relabel();
		update_mxm_window();
		return 0;
	case WM_COMMAND:
		if (LOWORD(wp) == ID_MXM_SAVE || LOWORD(wp) == IDOK || LOWORD(wp) == ID_MXM_CLEAR) {
			wchar_t token[256] = L"";
			if (LOWORD(wp) != ID_MXM_CLEAR) GetDlgItemTextW(hwnd, ID_MXM_TOKEN, token, 256);
			squeeze(token);
			if (LOWORD(wp) != ID_MXM_CLEAR && !token[0]) {
				copy_str(g_mxmMessage, 300, T(L"Вставьте токен.", L"Paste a token."));
			} else {
				EnterCriticalSection(&g_settingsLock);
				copy_str(g_settings.mxm, 256, token);
				LeaveCriticalSection(&g_settingsLock);
				settings_save();
				SetDlgItemTextW(hwnd, ID_MXM_TOKEN, L"");
				copy_str(g_mxmMessage, 300,
					token[0] ? T(L"Сохранено. Токен работает со следующего трека или после «Искать заново».",
								   L"Saved. The token works from the next track, or after “Search again”.")
							 : T(L"Токен убран.", L"The token was removed."));
			}
			SecureZeroMemory(token, sizeof(token));
			update_mxm_window();
		} else if (LOWORD(wp) == IDCANCEL) {
			DestroyWindow(hwnd);
		}
		return 0;
	case WM_DRAWITEM:
		draw_button((const DRAWITEMSTRUCT *)lp, C_BG);
		return TRUE;
	case WM_CTLCOLOREDIT:
	case WM_CTLCOLORSTATIC:
		return edit_colors((HDC)wp);
	case WM_ERASEBKGND:
		return 1;
	case WM_PAINT:
		paint_buffered(hwnd, paint_mxm);
		return 0;
	case WM_DESTROY:
		g_mxmWnd = NULL;
		return 0;
	}
	return DefWindowProcW(hwnd, msg, wp, lp);
}

/* --- the journal ----------------------------------------------------------- */

static int g_logShown = -1;

static void update_log_window(void) {
	Text all = { 0 };
	wchar_t *wide;
	int count, first;
	if (!g_logWnd) return;
	EnterCriticalSection(&g_logLock);
	count = g_logCount;
	if (count == g_logShown) {
		LeaveCriticalSection(&g_logLock);
		return;
	}
	first = count > LOG_LINES ? count - LOG_LINES : 0;
	for (int i = first; i < count; i++) {
		char *utf8 = utf8_of(g_log[i % LOG_LINES]);
		if (utf8) {
			text_raw(&all, utf8);
			text_raw(&all, "\r\n");
			free(utf8);
		}
	}
	LeaveCriticalSection(&g_logLock);
	g_logShown = count;
	wide = all.s ? wide_of_utf8(all.s) : NULL;
	SetWindowTextW(GetDlgItem(g_logWnd, ID_LOG_TEXT), wide ? wide : T(L"Журнал пуст.", L"The journal is empty."));
	SendDlgItemMessageW(g_logWnd, ID_LOG_TEXT, EM_SETSEL, (WPARAM)-1, (LPARAM)-1);
	SendDlgItemMessageW(g_logWnd, ID_LOG_TEXT, WM_VSCROLL, SB_BOTTOM, 0);
	free(wide);
	free(all.s);
}

static void paint_log(HWND hwnd, HDC dc) {
	RECT all;
	GetClientRect(hwnd, &all);
	fill(dc, &all, C_WELL);
}

static LRESULT CALLBACK log_proc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
	switch (msg) {
	case WM_CREATE:
		make_edit(hwnd, ID_LOG_TEXT, ES_MULTILINE | ES_READONLY | ES_AUTOVSCROLL | WS_VSCROLL, 0, 0, 10, 10, g_fontMono);
		SendDlgItemMessageW(hwnd, ID_LOG_TEXT, EM_SETLIMITTEXT, 0, 0);
		g_logWnd = hwnd;
		g_logShown = -1;
		update_log_window();
		return 0;
	case WM_SIZE:
		MoveWindow(GetDlgItem(hwnd, ID_LOG_TEXT), S(10), S(8), LOWORD(lp) - S(12), HIWORD(lp) - S(10), TRUE);
		return 0;
	case WM_GETMINMAXINFO:
		((MINMAXINFO *)lp)->ptMinTrackSize.x = S(360);
		((MINMAXINFO *)lp)->ptMinTrackSize.y = S(200);
		return 0;
	case WM_COMMAND:
		if (LOWORD(wp) == IDCANCEL) DestroyWindow(hwnd);
		return 0;
	case WM_CTLCOLOREDIT:
	case WM_CTLCOLORSTATIC:
		return edit_colors((HDC)wp);
	case WM_ERASEBKGND:
		return 1;
	case WM_PAINT:
		paint_buffered(hwnd, paint_log);
		return 0;
	case WM_DESTROY:
		g_logWnd = NULL;
		return 0;
	}
	return DefWindowProcW(hwnd, msg, wp, lp);
}

/* ---------------------------------------------- pictures of it, for tests */

static void save_bmp(HWND hwnd, const wchar_t *name) {
	RECT client;
	HDC dc, mem;
	BITMAPINFO info;
	BITMAPFILEHEADER header;
	void *bits = NULL;
	HBITMAP dib, old;
	wchar_t path[MAX_PATH + 64];
	HANDLE file;
	DWORD wrote, size;
	UpdateWindow(hwnd);
	GetClientRect(hwnd, &client);
	ZeroMemory(&info, sizeof(info));
	info.bmiHeader.biSize = sizeof(info.bmiHeader);
	info.bmiHeader.biWidth = client.right;
	info.bmiHeader.biHeight = client.bottom;
	info.bmiHeader.biPlanes = 1;
	info.bmiHeader.biBitCount = 24;
	size = (DWORD)(((client.right * 3 + 3) & ~3) * client.bottom);
	dc = GetDC(hwnd);
	mem = CreateCompatibleDC(dc);
	dib = CreateDIBSection(dc, &info, DIB_RGB_COLORS, &bits, NULL, 0);
	old = (HBITMAP)SelectObject(mem, dib);
	BitBlt(mem, 0, 0, client.right, client.bottom, dc, 0, 0, SRCCOPY);
	GdiFlush();
	_snwprintf(path, MAX_PATH + 64, L"%ls\\%ls.bmp", g_snapshotDir, name);
	file = CreateFileW(path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
	if (file != INVALID_HANDLE_VALUE) {
		ZeroMemory(&header, sizeof(header));
		header.bfType = 0x4D42;
		header.bfOffBits = sizeof(header) + sizeof(info.bmiHeader);
		header.bfSize = header.bfOffBits + size;
		WriteFile(file, &header, sizeof(header), &wrote, NULL);
		WriteFile(file, &info.bmiHeader, sizeof(info.bmiHeader), &wrote, NULL);
		WriteFile(file, bits, size, &wrote, NULL);
		CloseHandle(file);
	}
	SelectObject(mem, old);
	DeleteObject(dib);
	DeleteDC(mem);
	ReleaseDC(hwnd, dc);
}

#define TIMER_SNAPSHOT 1000
#define TIMER_COMMANDS 1100

static double g_snapshotAfter = 4; /* seconds before the first picture */

static void snapshot_step(int step) {
	const DWORD fixed = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU;
	switch (step) {
	case 0:
		save_bmp(g_main, L"main");
		open_tool_window(&g_mxmWnd, L"notGTLyricsBridgeMxm", L"Musixmatch", MXM_W, MXM_H, fixed);
		break;
	case 1:
		save_bmp(g_mxmWnd, L"musixmatch");
		DestroyWindow(g_mxmWnd);
		open_tool_window(&g_logWnd, L"notGTLyricsBridgeLog", T(L"Журнал Lyrics Bridge", L"Lyrics Bridge journal"), 640, 420, WS_OVERLAPPEDWINDOW);
		break;
	case 2:
		save_bmp(g_logWnd, L"journal");
		DestroyWindow(g_main);
		return;
	}
	SetTimer(g_main, (UINT_PTR)(TIMER_SNAPSHOT + step + 1), 700, NULL);
}

/* --command, for tests: a button pressed at a moment. */
static struct {
	int cmd;
	double at;
} g_scripted[32];
static int g_scriptedCount, g_scriptedDone;

/* --------------------------------------------------------- the main window */

static UINT g_taskbarCreated;

static void connect_now(void) {
	wchar_t address[512], key[256];
	GetDlgItemTextW(g_main, ID_ADDRESS, address, 512);
	GetDlgItemTextW(g_main, ID_KEY, key, 256);
	squeeze(address);
	squeeze(key);
	EnterCriticalSection(&g_settingsLock);
	copy_str(g_settings.address, 512, address);
	copy_str(g_settings.key, 256, key);
	LeaveCriticalSection(&g_settingsLock);
	SecureZeroMemory(key, sizeof(key));
	settings_save();
	ws_reconnect();
}

static LRESULT CALLBACK main_proc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
	const DWORD fixed = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU;
	if (msg == g_taskbarCreated && g_taskbarCreated && !g_snapshotDir[0]) {
		add_tray(); /* Explorer was restarted and forgot the icon */
		return 0;
	}
	switch (msg) {
	case WM_CREATE:
		g_main = hwnd;
		make_edit(hwnd, ID_ADDRESS, ES_AUTOHSCROLL, 44, 116, 180, 20, g_font);
		make_edit(hwnd, ID_KEY, ES_AUTOHSCROLL | ES_PASSWORD, 256, 116, 180, 20, g_font);
		SendDlgItemMessageW(hwnd, ID_ADDRESS, EM_SETLIMITTEXT, 500, 0);
		SendDlgItemMessageW(hwnd, ID_KEY, EM_SETLIMITTEXT, 250, 0);
		make_button(hwnd, ID_CONNECT, L"", BTN_PRIMARY, 334, 154, 112, 34);
		make_button(hwnd, ID_PREV, L"", BTN_NORMAL, 34, 454, 132, 34);
		make_button(hwnd, ID_NEXT, L"", BTN_NORMAL, 174, 454, 132, 34);
		make_button(hwnd, ID_SEARCH, L"", BTN_NORMAL, 314, 454, 132, 34);
		make_button(hwnd, ID_EARLIER, L"", BTN_NORMAL, 34, 518, 132, 34);
		make_button(hwnd, ID_RESET, L"", BTN_NORMAL, 174, 518, 132, 34);
		make_button(hwnd, ID_LATER, L"", BTN_NORMAL, 314, 518, 132, 34);
		make_button(hwnd, ID_SHOW_MXM, L"", BTN_GHOST, 20, 574, 140, 30);
		make_button(hwnd, ID_SHOW_LOG, L"", BTN_GHOST, 164, 574, 132, 30);
		make_button(hwnd, ID_LANG_RU, L"RU", BTN_LANG, 384, 29, 36, 22);
		make_button(hwnd, ID_LANG_EN, L"EN", BTN_LANG, 424, 29, 36, 22);
		EnterCriticalSection(&g_settingsLock);
		SetDlgItemTextW(hwnd, ID_ADDRESS, g_settings.address);
		SetDlgItemTextW(hwnd, ID_KEY, g_settings.key);
		LeaveCriticalSection(&g_settingsLock);
		relabel();
		apply_view();
		return 0;
	case WM_APP_VIEW:
		EnterCriticalSection(&g_viewLock);
		g_shown = g_view;
		LeaveCriticalSection(&g_viewLock);
		apply_view();
		return 0;
	case WM_APP_LOG:
		update_log_window();
		return 0;
	case WM_TIMER:
		if (wp >= TIMER_SNAPSHOT && wp < TIMER_SNAPSHOT + 10) {
			KillTimer(hwnd, wp);
			snapshot_step((int)(wp - TIMER_SNAPSHOT));
		} else if (wp == TIMER_COMMANDS) {
			double el = (now_ms() - g_started) / 1000.0;
			while (g_scriptedDone < g_scriptedCount && g_scripted[g_scriptedDone].at <= el) command(g_scripted[g_scriptedDone++].cmd);
		}
		return 0;
	case WM_APP_TRAY:
		if (lp == WM_LBUTTONUP || lp == WM_LBUTTONDBLCLK) show_window(hwnd);
		else if (lp == WM_RBUTTONUP || lp == WM_CONTEXTMENU) tray_menu();
		return 0;
	case WM_COMMAND:
		switch (LOWORD(wp)) {
		case IDOK: /* Enter in a field */
		case ID_CONNECT:
			connect_now();
			break;
		case ID_PREV:
			command(CMD_PREV);
			break;
		case ID_NEXT:
			command(CMD_NEXT);
			break;
		case ID_SEARCH:
			command(CMD_SEARCH);
			break;
		case ID_EARLIER:
			command(CMD_EARLIER);
			break;
		case ID_RESET:
			command(CMD_RESET);
			break;
		case ID_LATER:
			command(CMD_LATER);
			break;
		case ID_SHOW_MXM:
			open_tool_window(&g_mxmWnd, L"notGTLyricsBridgeMxm", L"Musixmatch", MXM_W, MXM_H, fixed);
			break;
		case ID_SHOW_LOG:
			open_tool_window(&g_logWnd, L"notGTLyricsBridgeLog", T(L"Журнал Lyrics Bridge", L"Lyrics Bridge journal"), 640, 420, WS_OVERLAPPEDWINDOW);
			break;
		case ID_TRAY_SHOW:
			show_window(hwnd);
			break;
		case ID_TRAY_QUIT:
			DestroyWindow(hwnd);
			break;
		case ID_LANG_RU:
		case ID_LANG_EN:
			if ((LOWORD(wp) == ID_LANG_EN) != (g_lang == 1)) {
				g_lang = LOWORD(wp) == ID_LANG_EN;
				EnterCriticalSection(&g_settingsLock);
				g_settings.lang = g_lang;
				LeaveCriticalSection(&g_settingsLock);
				settings_save();
				relabel();
				apply_view();
			}
			break;
		}
		return 0;
	case WM_DRAWITEM: {
		const DRAWITEMSTRUCT *item = (const DRAWITEMSTRUCT *)lp;
		BOOL onGround = item->CtlID == ID_SHOW_MXM || item->CtlID == ID_SHOW_LOG || item->CtlID == ID_LANG_RU || item->CtlID == ID_LANG_EN;
		draw_button(item, onGround ? C_BG : C_CARD);
		return TRUE;
	}
	case WM_CTLCOLOREDIT:
	case WM_CTLCOLORSTATIC:
		return edit_colors((HDC)wp);
	case WM_ERASEBKGND:
		return 1;
	case WM_PAINT:
		paint_buffered(hwnd, paint_main);
		return 0;
	case WM_CLOSE:
		/* Closing hides: the bridge goes on, from the notification area. */
		if (g_snapshotDir[0]) {
			DestroyWindow(hwnd);
		} else {
			ShowWindow(hwnd, SW_HIDE);
			tray_hint();
		}
		return 0;
	case WM_ENDSESSION:
		if (wp) DestroyWindow(hwnd); /* Windows is shutting down */
		return 0;
	case WM_DESTROY:
		if (!g_snapshotDir[0]) Shell_NotifyIconW(NIM_DELETE, &g_tray);
		PostQuitMessage(0);
		return 0;
	}
	return DefWindowProcW(hwnd, msg, wp, lp);
}

/* ------------------------------------------------------------------- start */

static void register_class(const wchar_t *name, WNDPROC proc) {
	WNDCLASSEXW wc;
	ZeroMemory(&wc, sizeof(wc));
	wc.cbSize = sizeof(wc);
	wc.lpfnWndProc = proc;
	wc.hInstance = g_instance;
	wc.hIcon = g_icon;
	wc.hIconSm = g_iconSmall;
	wc.hCursor = LoadCursorW(NULL, (LPCWSTR)IDC_ARROW);
	wc.lpszClassName = name;
	RegisterClassExW(&wc);
}

/* <a user folder>\notGT\<name>; CSIDL_APPDATA or CSIDL_LOCAL_APPDATA. */
static void known_path(int folder, const wchar_t *name, wchar_t *out) {
	wchar_t base[MAX_PATH];
	if (SHGetFolderPathW(NULL, folder | CSIDL_FLAG_CREATE, NULL, SHGFP_TYPE_CURRENT, base) == S_OK)
		_snwprintf(out, MAX_PATH, L"%ls\\notGT\\%ls", base, name);
	else
		_snwprintf(out, MAX_PATH, L"notGT-%ls", name);
	out[MAX_PATH - 1] = L'\0';
}

/* The keys --command takes: n, p, +, -, 0, r. */
static int command_of(wchar_t key) {
	switch (key) {
	case L'n':
		return CMD_NEXT;
	case L'p':
		return CMD_PREV;
	case L'+':
		return CMD_LATER;
	case L'-':
		return CMD_EARLIER;
	case L'0':
		return CMD_RESET;
	case L'r':
		return CMD_SEARCH;
	}
	return 0;
}

int wmain(int argc, wchar_t **argv) {
	const DWORD style = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX;
	BOOL hidden = FALSE;
	HANDLE once, threads[2];
	RECT frame;
	HDC screen;
	MSG msg;
	int dpiOverride = 0;

	g_instance = GetModuleHandleW(NULL);
	g_lang = PRIMARYLANGID(GetUserDefaultUILanguage()) != LANG_RUSSIAN;
	known_path(CSIDL_APPDATA, L"lyrics-bridge.json", g_settingsPath);
	known_path(CSIDL_LOCAL_APPDATA, L"lyrics-bridge", g_cacheDir);
	for (int i = 1; i < argc; i++) {
		if (!wcscmp(argv[i], L"--snapshot") && i + 1 < argc) copy_str(g_snapshotDir, MAX_PATH, argv[++i]);
		else if (!wcscmp(argv[i], L"--snapshot-after") && i + 1 < argc) g_snapshotAfter = _wtof(argv[++i]);
		else if (!wcscmp(argv[i], L"--dpi") && i + 1 < argc) dpiOverride = _wtoi(argv[++i]);
		else if (!wcscmp(argv[i], L"--settings") && i + 1 < argc) copy_str(g_settingsPath, MAX_PATH, argv[++i]);
		else if (!wcscmp(argv[i], L"--cache") && i + 1 < argc) copy_str(g_cacheDir, MAX_PATH, argv[++i]);
		else if (!wcscmp(argv[i], L"--simulate")) g_playerKind = PLAYER_SIMULATE;
		else if (!wcscmp(argv[i], L"--hidden")) hidden = TRUE;
		else if (!wcscmp(argv[i], L"--log-file") && i + 1 < argc)
			g_logFile = CreateFileW(argv[++i], GENERIC_WRITE, FILE_SHARE_READ, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
		else if (!wcscmp(argv[i], L"--command") && i + 1 < argc) {
			const wchar_t *spec = argv[++i], *at = wcschr(spec, L'@');
			if (at && g_scriptedCount < 32 && command_of(spec[0])) {
				g_scripted[g_scriptedCount].cmd = command_of(spec[0]);
				g_scripted[g_scriptedCount++].at = _wtof(at + 1);
			}
		} else if (!wcscmp(argv[i], L"--fake") && i + 1 < argc) {
			/* "Artist|Title|seconds|from" */
			wchar_t spec[700], *ctx = NULL, *part;
			copy_str(spec, 700, argv[++i]);
			g_playerKind = PLAYER_FAKE;
			part = wcstok(spec, L"|", &ctx);
			copy_str(g_fakeArtist, 256, part);
			part = wcstok(NULL, L"|", &ctx);
			copy_str(g_fakeTitle, 256, part);
			part = wcstok(NULL, L"|", &ctx);
			g_fakeDuration = part ? _wtof(part) : 180;
			part = wcstok(NULL, L"|", &ctx);
			g_fakeFrom = part ? _wtof(part) : 0;
		}
	}

	/* A second start shows the window that is already there. */
	once = CreateMutexW(NULL, FALSE, L"Local\\notGT-LyricsBridge");
	if (once && GetLastError() == ERROR_ALREADY_EXISTS && !g_snapshotDir[0]) {
		HWND existing = FindWindowW(L"notGTLyricsBridge", NULL);
		if (existing) show_window(existing);
		return 0;
	}

	InitializeCriticalSection(&g_logLock);
	InitializeCriticalSection(&g_settingsLock);
	InitializeCriticalSection(&g_wsLock);
	InitializeCriticalSection(&g_viewLock);
	InitializeCriticalSection(&g_inboxLock);
	InitializeCriticalSection(&g_cmdLock);
	lyrics_log = log_line;
	settings_load();
	if (g_settings.lang >= 0) g_lang = g_settings.lang;
	SHCreateDirectoryExW(NULL, g_cacheDir, NULL);
	net_init();
	g_started = now_ms();

	screen = GetDC(NULL);
	g_dpi = dpiOverride > 0 ? dpiOverride : GetDeviceCaps(screen, LOGPIXELSX);
	ReleaseDC(NULL, screen);
	g_font = make_font(13, FW_NORMAL, L"Segoe UI");
	g_fontBold = make_font(13, FW_SEMIBOLD, L"Segoe UI");
	g_fontSmall = make_font(12, FW_NORMAL, L"Segoe UI");
	g_fontCaps = make_font(11, FW_SEMIBOLD, L"Segoe UI");
	g_fontBig = make_font(18, FW_SEMIBOLD, L"Segoe UI");
	g_fontMono = make_font(12, FW_NORMAL, L"Consolas");
	g_brushWell = CreateSolidBrush(C_WELL);
	g_icon = (HICON)LoadImageW(g_instance, MAKEINTRESOURCEW(1), IMAGE_ICON, GetSystemMetrics(SM_CXICON),
		GetSystemMetrics(SM_CYICON), 0);
	g_iconSmall = (HICON)LoadImageW(g_instance, MAKEINTRESOURCEW(1), IMAGE_ICON, GetSystemMetrics(SM_CXSMICON),
		GetSystemMetrics(SM_CYSMICON), 0);
	load_logo();

	g_quit = CreateEventW(NULL, TRUE, FALSE, NULL);
	g_engineWake = CreateEventW(NULL, FALSE, FALSE, NULL);
	g_wsWake = CreateEventW(NULL, FALSE, FALSE, NULL);
	g_taskbarCreated = RegisterWindowMessageW(L"TaskbarCreated");
	register_class(L"notGTLyricsBridge", main_proc);
	register_class(L"notGTLyricsBridgeMxm", mxm_proc);
	register_class(L"notGTLyricsBridgeLog", log_proc);

	SetRect(&frame, 0, 0, S(MAIN_W), S(MAIN_H));
	AdjustWindowRectEx(&frame, style, FALSE, 0);
	CreateWindowExW(0, L"notGTLyricsBridge", L"notGT", style, CW_USEDEFAULT, CW_USEDEFAULT, frame.right - frame.left,
		frame.bottom - frame.top, NULL, NULL, g_instance, NULL);
	if (!g_main) return 1;
	brand_title_bar(g_main);
	if (!g_snapshotDir[0]) add_tray();
	if (!hidden || g_snapshotDir[0]) {
		ShowWindow(g_main, SW_SHOW);
		UpdateWindow(g_main);
	}
	log_line(L"notGT Lyrics Bridge started");

	threads[0] = CreateThread(NULL, 0, engine_thread, NULL, 0, NULL);
	threads[1] = CreateThread(NULL, 0, ws_thread, NULL, 0, NULL);
	if (g_scriptedCount) SetTimer(g_main, TIMER_COMMANDS, 100, NULL);
	if (g_snapshotDir[0]) SetTimer(g_main, TIMER_SNAPSHOT, (UINT)(g_snapshotAfter * 1000), NULL);

	while (GetMessageW(&msg, NULL, 0, 0) > 0) {
		/* Tab, Enter and Esc work in every window as they do in a dialog. */
		HWND top = GetAncestor(msg.hwnd, GA_ROOT);
		if (top && (top == g_main || top == g_mxmWnd || top == g_logWnd) && IsDialogMessageW(top, &msg)) continue;
		TranslateMessage(&msg);
		DispatchMessageW(&msg);
	}

	/* Quitting: the engine tells the title nothing plays any more, then the connection closes. */
	g_main = NULL;
	SetEvent(g_quit);
	SetEvent(g_wsWake);
	WaitForSingleObject(threads[0], 3000);
	EnterCriticalSection(&g_wsLock);
	if (g_wsOpen) ws_shutdown(&g_ws);
	LeaveCriticalSection(&g_wsLock);
	WaitForSingleObject(threads[1], 3000);
	if (g_logFile != INVALID_HANDLE_VALUE) CloseHandle(g_logFile);
	if (once) CloseHandle(once);
	return 0;
}
