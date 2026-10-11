/*
 * notGT Launcher — the window a Windows user starts notGT from.
 *
 * A compact, branded window in the spirit of the Bitfocus Companion launcher:
 * pick a network interface and a port, start the server, open the dashboard.
 * Signing in, the firewall and the server log each have a small window of
 * their own, and the program sits in the notification area while it runs.
 *
 * Closing the launcher does not stop the server: it keeps running in the
 * background, and the next time the launcher is started its window shows it.
 *
 * The window is only a face. What it asks for is done by
 * `launcher/index.mjs`, a Node process that this program starts (hidden, with
 * the bundled node.exe) and talks to over its control API on 127.0.0.1 — see
 * backend.h. So there is one implementation of "start NodeCG", "add a firewall
 * rule" and the rest, shared with the browser page that `node
 * launcher/index.mjs` serves on other platforms.
 *
 * It depends on nothing but Windows itself (user32, gdi32, shell32, winhttp,
 * gdiplus, ole32).
 *
 * Build (mingw-w64) — scripts/build-windows.mjs does this:
 *   x86_64-w64-mingw32-windres notGT-launcher.rc -O coff -o launcher-res.o
 *   x86_64-w64-mingw32-gcc -O2 -municode -mwindows -o "notGT Launcher.exe" \
 *     notGT-launcher.c launcher-res.o -lwinhttp -lgdiplus -lole32 -lshell32 -lgdi32 -lcomctl32
 *
 * For development and tests (see scripts/e2e-launcher-window.mjs):
 *   --control-url http://127.0.0.1:<port>   attach to a running launcher/index.mjs
 *   --snapshot <dir>                        save pictures of every window as .bmp, then exit
 */

#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#define _WIN32_WINNT 0x0601
#define WIN32_LEAN_AND_MEAN

#include <windows.h>
#include <commctrl.h>
#include <objidl.h>
#include <shellapi.h>
#include <wchar.h>

/*
 * The window speaks Russian and English. Every text is written here in both,
 * side by side, and `T` picks one — so a switch of language is a repaint.
 * Which language it is comes from the backend (launcher-config.json remembers
 * it), and until the backend has answered it is the language of Windows.
 */
static int g_lang; /* 0 = Russian, 1 = English */
#define T(ru, en) (g_lang ? (en) : (ru))

#include "backend.h"
#include "json.h"

/* Extended-length paths; the default MAX_PATH is too small. */
#define NOTGT_MAX_PATH 32768

/* ------------------------------------------------------------------- brand */
/* The dark theme of the dashboard (bundles/notGT/dashboard/ui.css): Cream on
 * Studio, Signal as the accent, Lemon for "this is on air". */
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

/* ---------------------------------------------------------------- messages */
#define WM_APP_STATE (WM_APP + 1) /* lParam: AppState* (or NULL: no answer) */
#define WM_APP_RESULT (WM_APP + 2) /* lParam: ActionResult* */
#define WM_APP_TRAY (WM_APP + 3)
#define WM_APP_SNAPSHOT (WM_APP + 4)

enum {
	ID_IFACE = 100,
	ID_PORT,
	ID_START,
	ID_STOP,
	ID_OPEN,
	ID_URL,
	ID_COPY,
	ID_SHOW_LOGIN,
	ID_SHOW_NETWORK,
	ID_SHOW_LOG,
	ID_LOGIN_USER,
	ID_LOGIN_PASS,
	ID_LOGIN_SAVE,
	ID_LOGIN_TOGGLE,
	ID_NET_CHECK,
	ID_NET_ALLOW,
	ID_NET_REMOVE,
	ID_NET_RESULT,
	ID_LOG_TEXT,
	ID_TRAY_OPEN,
	ID_TRAY_SHOW,
	ID_TRAY_QUIT,
	ID_TRAY_STOP_QUIT,
	ID_LANG_RU,
	ID_LANG_EN,
	ID_IFACE_FIRST = 2000,
};

/* How a button is drawn; kept in its GWLP_USERDATA. */
enum { BTN_NORMAL, BTN_PRIMARY, BTN_GHOST, BTN_SELECT, BTN_LANG };

/* ------------------------------------------------------------------- state */

#define MAX_INTERFACES 32

typedef struct {
	wchar_t id[64];
	wchar_t label[160];
} Interface;

/* What launcher/index.mjs says in GET /api/state — the parts shown here. */
typedef struct {
	wchar_t version[32];
	wchar_t status[24];
	wchar_t statusText[1024];
	wchar_t warning[1024];
	wchar_t host[64];
	wchar_t guiUrl[512];
	int port;
	BOOL running;
	BOOL loginEnabled;
	BOOL loginDefaultPassword;
	wchar_t loginSource[16];
	wchar_t loginUser[128];
	BOOL fwSupported;
	BOOL fwRuleExists;
	int fwPort;
	wchar_t fwRuleName[96];
	Interface interfaces[MAX_INTERFACES];
	int interfaceCount;
	int lang; /* 0 = Russian, 1 = English */
	wchar_t *logs; /* the server log, lines joined with CRLF */
	int logCount;
} AppState;

typedef enum {
	ACT_START,
	ACT_STOP,
	ACT_LOGIN_SET,
	ACT_LOGIN_OFF,
	ACT_LOGIN_DEFAULT,
	ACT_FW_ALLOW,
	ACT_FW_REMOVE,
	ACT_DIAGNOSE,
	ACT_LANG,
} ActionKind;

typedef struct Action {
	ActionKind kind;
	wchar_t a[256];
	wchar_t b[256];
	int port;
	struct Action *next;
} Action;

typedef struct {
	ActionKind kind;
	DWORD status;
	JVal *json;
} ActionResult;

static HINSTANCE g_instance;
static Backend g_backend;
static HWND g_main, g_loginWnd, g_networkWnd, g_logWnd;
static AppState *g_state; /* the last answer; NULL until the first one */
static int g_missed; /* polls in a row without an answer */
static int g_dpi = 96;
static HFONT g_font, g_fontBold, g_fontSmall, g_fontCaps, g_fontMono;
static HBRUSH g_brushBg, g_brushWell;
static HBITMAP g_logo;
static int g_logoW, g_logoH;
static HICON g_icon, g_iconSmall;

/* What the user chose before pressing "Запустить"; until they touch it, the
 * window shows what the backend remembers from last time. */
static wchar_t g_selHost[64] = L"0.0.0.0";
static BOOL g_userTouched;
/* A language was just chosen here and the backend has not confirmed it yet:
 * until it does, an older answer must not switch the window back. */
static BOOL g_langPending;

static HANDLE g_pollNow, g_actionReady, g_quit;
static CRITICAL_SECTION g_actionLock;
static Action *g_actions;

static wchar_t g_loginMessage[512], g_networkMessage[2048];
static BOOL g_networkBusy;
static wchar_t g_snapshotDir[MAX_PATH];
static NOTIFYICONDATAW g_tray;

/* Logical (96 dpi) pixels to device pixels. */
static int S(int v) {
	return MulDiv(v, g_dpi, 96);
}

static RECT R(int x, int y, int w, int h) {
	RECT r = { S(x), S(y), S(x + w), S(y + h) };
	return r;
}

/* ----------------------------------------------------------------- drawing */

/* GDI+ is used for one thing — decoding the logo's PNG — so its few flat
 * entry points are declared here instead of pulling in its C++ headers. */
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

/* The logo, composited on the window's ground: a plain bitmap to blit. */
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
		/* ARGB of C_BG: the transparent parts take the window's colour. */
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

/*
 * A filled rounded rectangle with smooth corners. GDI draws them jagged, so
 * the shape is drawn four times as large and scaled down — `ground` is the
 * colour around it, which the corners blend into.
 */
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
		/* A wrapped line can be drawn a pixel or two wider than it was
		 * measured (a substituted font does that); the last letter is let
		 * out into the margin instead of being cut. Height still clips. */
		saved = SaveDC(dc);
		IntersectClipRect(dc, r.left, r.top, r.right + S(10), r.bottom);
		format |= DT_NOCLIP;
	}
	DrawTextW(dc, s, -1, &r, format | DT_NOPREFIX);
	if (saved) RestoreDC(dc, saved);
	SelectObject(dc, old);
}

/* A card: the raised block the controls sit on. */
static void card(HDC dc, int x, int y, int w, int h) {
	RECT r = R(x, y, w, h);
	fill_round(dc, &r, S(10), C_CARD, C_BG);
}

/* The sunken box an edit control sits in. */
static void well(HDC dc, int x, int y, int w, int h, COLORREF ground) {
	RECT r = R(x, y, w, h);
	fill_round(dc, &r, S(6), C_LINE, ground);
	InflateRect(&r, -S(1), -S(1));
	fill_round(dc, &r, S(5), C_WELL, C_LINE);
}

/* The small capital label above a field. */
static void caps(HDC dc, const wchar_t *s, int x, int y) {
	text(dc, s, R(x, y, 300, 16), g_fontCaps, C_MUTED, DT_LEFT | DT_SINGLELINE);
}

/* ----------------------------------------------------------------- buttons */

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

/* `ground` is the colour of what the button sits on. */
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
	} else if (kind == BTN_SELECT) {
		face = C_WELL;
		ink = disabled ? C_FAINT : C_TEXT;
	} else if (kind == BTN_LANG) {
		/* The language in use is the lit one of the pair. */
		BOOL current = (GetDlgCtrlID(item->hwndItem) == ID_LANG_EN) == (g_lang == 1);
		face = current ? C_CONTROL : hot ? C_CARD : ground;
		ink = current ? C_TEXT : C_MUTED;
	} else {
		face = hot || pressed ? C_CONTROL_HOT : C_CONTROL;
		ink = disabled ? C_FAINT : C_TEXT;
	}

	if (kind == BTN_SELECT) {
		/* Looks like a field: it opens the list of interfaces. */
		RECT inner = r, arrow = r;
		fill_round(dc, &r, S(6), hot ? C_FAINT : C_LINE, ground);
		InflateRect(&inner, -S(1), -S(1));
		fill_round(dc, &inner, S(5), face, hot ? C_FAINT : C_LINE);
		inner.left += S(10);
		inner.right -= S(28);
		text(dc, label, inner, g_font, ink, DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS);
		{
			int cx = arrow.right - S(16), cy = (arrow.top + arrow.bottom) / 2;
			POINT tip[3] = { { cx - S(4), cy - S(2) }, { cx + S(4), cy - S(2) }, { cx, cy + S(3) } };
			HBRUSH oldBrush = (HBRUSH)SelectObject(dc, GetStockObject(DC_BRUSH));
			HPEN oldPen = (HPEN)SelectObject(dc, GetStockObject(NULL_PEN));
			SetDCBrushColor(dc, disabled ? C_FAINT : C_MUTED);
			Polygon(dc, tip, 3);
			SelectObject(dc, oldPen);
			SelectObject(dc, oldBrush);
		}
	} else {
		if (face != ground) fill_round(dc, &r, S(6), face, ground);
		if (pressed) OffsetRect(&r, 0, S(1));
		text(dc, label, r, kind == BTN_GHOST ? g_font : kind == BTN_LANG ? g_fontCaps : g_fontBold, ink,
			DT_CENTER | DT_VCENTER | DT_SINGLELINE);
	}
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

/* Cream on the well, for every edit control (read-only ones ask as statics). */
static LRESULT edit_colors(HDC dc) {
	SetTextColor(dc, C_TEXT);
	SetBkColor(dc, C_WELL);
	return (LRESULT)g_brushWell;
}

/* Sets a control's text only when it differs: no flicker, and the caret and
 * the selection of a field the user is in are left alone. */
static void set_text(HWND hwnd, const wchar_t *value) {
	int len = GetWindowTextLengthW(hwnd);
	wchar_t *current = (wchar_t *)malloc(((size_t)len + 1) * sizeof(wchar_t));
	if (!current) return;
	GetWindowTextW(hwnd, current, len + 1);
	if (wcscmp(current, value)) SetWindowTextW(hwnd, value);
	free(current);
}

/* ----------------------------------------------------- talking to the backend */

static void copy_str(wchar_t *out, size_t len, const wchar_t *value) {
	wcsncpy(out, value ? value : L"", len - 1);
	out[len - 1] = L'\0';
}

static void state_free(AppState *state) {
	if (!state) return;
	free(state->logs);
	free(state);
}

/* The server log as one text. NodeCG colours its lines for a terminal; the
 * escape sequences are dropped. */
static wchar_t *join_logs(const JVal *lines) {
	size_t total = 1, used = 0;
	wchar_t *out;
	for (const JVal *line = lines ? lines->child : NULL; line; line = line->next) {
		if (line->type == J_STR && line->str) total += wcslen(line->str) + 2;
	}
	out = (wchar_t *)malloc(total * sizeof(wchar_t));
	if (!out) return NULL;
	for (const JVal *line = lines ? lines->child : NULL; line; line = line->next) {
		if (line->type != J_STR || !line->str) continue;
		for (const wchar_t *c = line->str; *c; c++) {
			if (*c == 0x1B && c[1] == L'[') {
				c += 2;
				while (*c && !(*c >= L'@' && *c <= L'~')) c++;
				if (!*c) break;
				continue;
			}
			if (*c != L'\r' && *c != L'\n') out[used++] = *c;
		}
		out[used++] = L'\r';
		out[used++] = L'\n';
	}
	out[used] = L'\0';
	return out;
}

static AppState *state_from_json(const JVal *root) {
	AppState *state = (AppState *)calloc(1, sizeof(AppState));
	const JVal *login = json_get(root, L"login"), *firewall = json_get(root, L"firewall");
	const JVal *interfaces = json_get(root, L"interfaces");
	if (!state) return NULL;
	copy_str(state->version, 32, json_str(root, L"version"));
	copy_str(state->status, 24, json_str(root, L"status"));
	copy_str(state->statusText, 1024, json_str(root, L"statusText"));
	copy_str(state->warning, 1024, json_str(root, L"warning"));
	copy_str(state->host, 64, json_str(root, L"host"));
	copy_str(state->guiUrl, 512, json_str(root, L"guiUrl"));
	state->port = (int)json_num(root, L"port", 9090);
	state->running = json_bool(root, L"running");
	state->loginEnabled = json_bool(login, L"enabled");
	state->loginDefaultPassword = json_bool(login, L"defaultPassword");
	copy_str(state->loginSource, 16, json_str(login, L"source"));
	copy_str(state->loginUser, 128, json_str(login, L"username"));
	state->fwSupported = json_bool(firewall, L"supported");
	state->fwRuleExists = json_bool(firewall, L"ruleExists");
	state->fwPort = (int)json_num(firewall, L"port", state->port);
	copy_str(state->fwRuleName, 96, json_str(firewall, L"ruleName"));
	for (const JVal *item = interfaces ? interfaces->child : NULL; item && state->interfaceCount < MAX_INTERFACES;
		item = item->next) {
		Interface *entry = &state->interfaces[state->interfaceCount];
		const wchar_t *id = json_str(item, L"id");
		if (!*id) id = json_str(item, L"address");
		if (!*id) continue;
		copy_str(entry->id, 64, id);
		copy_str(entry->label, 160, *json_str(item, L"label") ? json_str(item, L"label") : id);
		state->interfaceCount++;
	}
	state->lang = !wcscmp(json_str(root, L"lang"), L"en");
	state->logs = join_logs(json_get(root, L"logs"));
	state->logCount = (int)json_num(root, L"logCount", 0);
	return state;
}

/* Asks for the state once a second, and at once when something was done. */
static DWORD WINAPI poll_thread(LPVOID unused) {
	HANDLE wake[2] = { g_quit, g_pollNow };
	(void)unused;
	for (;;) {
		char *body = NULL;
		AppState *state = NULL;
		if (backend_request(&g_backend, L"GET", L"/api/state", NULL, FALSE, &body) == 200) {
			JVal *root = json_parse(body);
			if (root) state = state_from_json(root);
			json_free(root);
		}
		free(body);
		if (!PostMessageW(g_main, WM_APP_STATE, 0, (LPARAM)state)) state_free(state);
		if (WaitForMultipleObjects(2, wake, FALSE, 1000) == WAIT_OBJECT_0) return 0;
	}
}

static void enqueue(ActionKind kind, const wchar_t *a, const wchar_t *b, int port) {
	Action *action = (Action *)calloc(1, sizeof(Action)), **tail;
	if (!action) return;
	action->kind = kind;
	action->port = port;
	copy_str(action->a, 256, a);
	copy_str(action->b, 256, b);
	EnterCriticalSection(&g_actionLock);
	for (tail = &g_actions; *tail; tail = &(*tail)->next) {
	}
	*tail = action;
	LeaveCriticalSection(&g_actionLock);
	SetEvent(g_actionReady);
}

/* Does what the user asked for, one request at a time, off the window's thread:
 * some of them wait for a person (a UAC prompt) or for a slow network probe. */
static DWORD WINAPI action_thread(LPVOID unused) {
	HANDLE wake[2] = { g_quit, g_actionReady };
	(void)unused;
	for (;;) {
		Action *action;
		if (WaitForMultipleObjects(2, wake, FALSE, INFINITE) == WAIT_OBJECT_0) return 0;
		for (;;) {
			char body[4096] = "", *response = NULL;
			const wchar_t *method = L"POST", *path = L"";
			BOOL patient = FALSE;
			ActionResult *result;

			EnterCriticalSection(&g_actionLock);
			action = g_actions;
			if (action) g_actions = action->next;
			LeaveCriticalSection(&g_actionLock);
			if (!action) break;

			switch (action->kind) {
			case ACT_START:
				path = L"/api/start";
				strcpy(body, "{\"host\":");
				backend_json_string(body, sizeof(body), action->a);
				snprintf(body + strlen(body), sizeof(body) - strlen(body), ",\"port\":%d}", action->port);
				break;
			case ACT_STOP:
				path = L"/api/stop";
				strcpy(body, "{}");
				break;
			case ACT_LOGIN_SET:
				path = L"/api/login";
				strcpy(body, "{\"username\":");
				backend_json_string(body, sizeof(body), action->a);
				strcat(body, ",\"password\":");
				backend_json_string(body, sizeof(body), action->b);
				strcat(body, "}");
				break;
			case ACT_LOGIN_OFF:
				path = L"/api/login/disable";
				strcpy(body, "{}");
				break;
			case ACT_LOGIN_DEFAULT:
				path = L"/api/login/default";
				strcpy(body, "{}");
				break;
			case ACT_FW_ALLOW:
			case ACT_FW_REMOVE:
				path = action->kind == ACT_FW_ALLOW ? L"/api/firewall/allow" : L"/api/firewall/remove";
				snprintf(body, sizeof(body), "{\"port\":%d}", action->port);
				patient = TRUE;
				break;
			case ACT_LANG:
				path = L"/api/lang";
				strcpy(body, "{\"lang\":");
				backend_json_string(body, sizeof(body), action->a);
				strcat(body, "}");
				break;
			case ACT_DIAGNOSE:
				method = L"GET";
				path = L"/api/diagnostics";
				patient = TRUE;
				break;
			}

			result = (ActionResult *)calloc(1, sizeof(ActionResult));
			if (result) {
				result->kind = action->kind;
				result->status =
					backend_request(&g_backend, method, path, body[0] ? body : NULL, patient, &response);
				result->json = json_parse(response);
				if (!PostMessageW(g_main, WM_APP_RESULT, 0, (LPARAM)result)) {
					json_free(result->json);
					free(result);
				}
			}
			SecureZeroMemory(action, sizeof(*action)); /* it may have held a password */
			SecureZeroMemory(body, sizeof(body));
			free(action);
			free(response);
			SetEvent(g_pollNow);
		}
	}
}

/* --------------------------------------------------- what the state means */

static BOOL status_is(const wchar_t *value) {
	return g_state && !wcscmp(g_state->status, value);
}

/* The server can be started: it is neither running nor on its way. */
static BOOL can_start(void) {
	return g_state && (status_is(L"stopped") || status_is(L"error"));
}

static const wchar_t *status_label(void) {
	if (!g_state) return g_missed > 3 ? T(L"нет связи", L"no answer") : T(L"запуск лончера…", L"starting the launcher…");
	if (status_is(L"running")) return T(L"запущен", L"running");
	if (status_is(L"starting")) return T(L"запуск…", L"starting…");
	if (status_is(L"stopping")) return T(L"остановка…", L"stopping…");
	if (status_is(L"error")) return T(L"ошибка", L"error");
	return T(L"остановлен", L"stopped");
}

static COLORREF status_color(void) {
	if (!g_state) return C_FAINT;
	if (status_is(L"running")) return C_LEMON;
	if (status_is(L"error")) return C_SIGNAL;
	if (status_is(L"starting") || status_is(L"stopping")) return C_AMBER;
	return C_FAINT;
}

static const wchar_t *interface_label(const wchar_t *id) {
	for (int i = 0; g_state && i < g_state->interfaceCount; i++) {
		if (!wcscmp(g_state->interfaces[i].id, id)) return g_state->interfaces[i].label;
	}
	return id;
}

static int chosen_port(void) {
	wchar_t value[16];
	GetWindowTextW(GetDlgItem(g_main, ID_PORT), value, 16);
	return _wtoi(value);
}

/* The address of the dashboard: the real one while the server runs, and what
 * it will be for the interface and the port chosen now while it does not. */
static void dashboard_url(wchar_t *out, size_t len) {
	BOOL any = !wcscmp(g_selHost, L"0.0.0.0") || !wcscmp(g_selHost, L"::");
	if (g_state && (!g_userTouched || !can_start())) {
		copy_str(out, len, g_state->guiUrl);
		return;
	}
	_snwprintf(out, len, wcschr(g_selHost, L':') && !any ? L"http://[%ls]:%d/dashboard/" : L"http://%ls:%d/dashboard/",
		any ? L"127.0.0.1" : g_selHost, chosen_port());
	out[len - 1] = L'\0';
}

static void login_summary(wchar_t *out, size_t len) {
	if (!g_state) {
		out[0] = L'\0';
	} else if (!g_state->loginEnabled) {
		copy_str(out, len, T(L"Вход по паролю выключен: панель открыта каждому, кто видит этот компьютер в сети.", L"The sign-in is off: the dashboard opens for anyone who can reach this computer."));
	} else if (!wcscmp(g_state->loginSource, L"launcher")) {
		_snwprintf(out, len, T(L"Вход по паролю включён · администратор %ls", L"The sign-in is on · administrator %ls"), g_state->loginUser);
		out[len - 1] = L'\0';
	} else if (g_state->loginDefaultPassword) {
		copy_str(out, len,
			T(L"Вход по паролю включён: admin / admin. Войдите и смените пароль во вкладке «Команда».", L"The sign-in is on: admin / admin. Sign in and change the password in the Team tab."));
	} else {
		copy_str(out, len, T(L"Вход по паролю включён · пользователи — в панели, во вкладке «Команда».", L"The sign-in is on · the users are kept in the dashboard, in the Team tab."));
	}
}

/* ------------------------------------------------------------- main window */

#define MAIN_W 480
#define MAIN_H 544

static void paint_main(HDC dc) {
	RECT all = R(0, 0, MAIN_W, MAIN_H), r;
	wchar_t line[1200];

	fill(dc, &all, C_BG);

	/* header: the logo and the version */
	if (g_logo) {
		HDC src = CreateCompatibleDC(dc);
		HBITMAP old = (HBITMAP)SelectObject(src, g_logo);
		int h = S(44), w = MulDiv(h, g_logoW, g_logoH);
		SetStretchBltMode(dc, HALFTONE);
		SetBrushOrgEx(dc, 0, 0, NULL);
		StretchBlt(dc, S(20), S(18), w, h, src, 0, 0, g_logoW, g_logoH, SRCCOPY);
		SelectObject(src, old);
		DeleteDC(src);
	} else {
		text(dc, L"notGT", R(20, 18, 200, 44), g_fontBold, C_TEXT, DT_LEFT | DT_VCENTER | DT_SINGLELINE);
	}
	if (g_state) {
		_snwprintf(line, 64, T(L"лончер v%ls", L"launcher v%ls"), g_state->version);
		text(dc, line, R(176, 18, 200, 44), g_fontSmall, C_FAINT, DT_RIGHT | DT_VCENTER | DT_SINGLELINE);
	}

	/* status */
	card(dc, 20, 78, 440, 100);
	{
		const wchar_t *label = status_label();
		SIZE size;
		HFONT old = (HFONT)SelectObject(dc, g_fontBold);
		RECT pill, dot;
		GetTextExtentPoint32W(dc, label, (int)wcslen(label), &size);
		SelectObject(dc, old);
		pill = R(34, 90, 0, 24);
		pill.right = pill.left + S(30) + size.cx + S(12);
		fill_round(dc, &pill, S(12), C_CONTROL, C_CARD);
		dot = R(44, 98, 8, 8);
		fill_round(dc, &dot, S(4), status_color(), C_CONTROL);
		r = pill;
		r.left += S(26);
		text(dc, label, r, g_fontBold, C_TEXT, DT_LEFT | DT_VCENTER | DT_SINGLELINE);
	}
	if (!g_state) {
		copy_str(line, 1200,
			!backend_alive(&g_backend)
				? T(L"Служебный процесс лончера завершился. Закройте программу и запустите её снова.", L"The launcher's service process has ended. Close the program and start it again.")
				: g_missed > 3 ? T(L"Служебный процесс лончера не отвечает. Закройте программу и запустите её снова.", L"The launcher's service process does not answer. Close the program and start it again.")
							   : T(L"Подождите пару секунд…", L"Just a moment…"));
	} else if (g_state->warning[0]) {
		_snwprintf(line, 1200, L"%ls %ls", g_state->statusText, g_state->warning);
		line[1199] = L'\0';
	} else {
		copy_str(line, 1200, g_state->statusText);
	}
	text(dc, line, R(34, 122, 412, 50), g_font, g_state && g_state->warning[0] ? C_AMBER : C_MUTED,
		DT_LEFT | DT_WORDBREAK | DT_END_ELLIPSIS | DT_EDITCONTROL);

	/* interface, port, the three buttons */
	card(dc, 20, 190, 440, 128);
	caps(dc, T(L"ИНТЕРФЕЙС", L"INTERFACE"), 34, 202);
	caps(dc, T(L"ПОРТ", L"PORT"), 334, 202);
	well(dc, 334, 220, 112, 34, C_CARD);

	/* the address */
	card(dc, 20, 330, 440, 112);
	caps(dc, T(L"АДРЕС ПАНЕЛИ", L"DASHBOARD ADDRESS"), 34, 342);
	well(dc, 34, 360, 304, 34, C_CARD);
	text(dc, T(L"Это адрес для оператора. В OBS добавляется другая ссылка — её копируют в самой панели, кнопкой «Ссылка для OBS».", L"This is the operator's address. OBS gets a different link — it is copied in the dashboard itself, with “Link for OBS”."),
		R(34, 402, 412, 34), g_fontSmall, C_FAINT, DT_LEFT | DT_WORDBREAK);

	/* sign-in, in one line */
	login_summary(line, 1200);
	text(dc, line, R(22, 452, 436, 34), g_fontSmall,
		g_state && g_state->loginEnabled && g_state->loginDefaultPassword ? C_AMBER : C_MUTED,
		DT_LEFT | DT_WORDBREAK | DT_END_ELLIPSIS | DT_EDITCONTROL);
}

static void relabel(void);
static void update_tray(void);
static void update_login_window(void);
static void update_network_window(void);
static void update_log_window(void);

/* Brings the controls in line with the state that just arrived. */
static void apply_state(void) {
	wchar_t url[600], port[16];
	BOOL idle = can_start();

	if (g_state && !g_langPending && g_state->lang != g_lang) {
		g_lang = g_state->lang;
		relabel();
	}

	if (g_state && !g_userTouched) {
		copy_str(g_selHost, 64, g_state->host);
		_snwprintf(port, 16, L"%d", g_state->port);
		set_text(GetDlgItem(g_main, ID_PORT), port);
	}
	set_text(GetDlgItem(g_main, ID_IFACE), interface_label(g_selHost));
	dashboard_url(url, 600);
	set_text(GetDlgItem(g_main, ID_URL), url);

	EnableWindow(GetDlgItem(g_main, ID_IFACE), idle);
	EnableWindow(GetDlgItem(g_main, ID_PORT), idle);
	EnableWindow(GetDlgItem(g_main, ID_START), idle);
	EnableWindow(GetDlgItem(g_main, ID_STOP), status_is(L"running") || status_is(L"starting"));
	EnableWindow(GetDlgItem(g_main, ID_OPEN), status_is(L"running"));
	EnableWindow(GetDlgItem(g_main, ID_COPY), g_state != NULL);
	/* Once the server is up, the choice is what it runs with again. */
	if (g_state && !idle) g_userTouched = FALSE;

	InvalidateRect(g_main, NULL, FALSE);
	update_tray();
	update_login_window();
	update_network_window();
	update_log_window();
}

static void copy_to_clipboard(HWND owner, const wchar_t *value) {
	size_t bytes = (wcslen(value) + 1) * sizeof(wchar_t);
	HGLOBAL memory = GlobalAlloc(GMEM_MOVEABLE, bytes);
	if (!memory) return;
	memcpy(GlobalLock(memory), value, bytes);
	GlobalUnlock(memory);
	if (OpenClipboard(owner)) {
		EmptyClipboard();
		if (!SetClipboardData(CF_UNICODETEXT, memory)) GlobalFree(memory);
		CloseClipboard();
	} else {
		GlobalFree(memory);
	}
}

static void open_dashboard(void) {
	if (g_state && g_state->guiUrl[0]) ShellExecuteW(g_main, L"open", g_state->guiUrl, NULL, NULL, SW_SHOWNORMAL);
}

static void choose_interface(HWND button) {
	HMENU menu = CreatePopupMenu();
	RECT r;
	int picked;
	if (!g_state || g_state->interfaceCount == 0) {
		DestroyMenu(menu);
		return;
	}
	for (int i = 0; i < g_state->interfaceCount; i++) {
		AppendMenuW(menu, MF_STRING | (!wcscmp(g_state->interfaces[i].id, g_selHost) ? MF_CHECKED : 0),
			(UINT_PTR)(ID_IFACE_FIRST + i), g_state->interfaces[i].label);
	}
	GetWindowRect(button, &r);
	picked = TrackPopupMenu(menu, TPM_RETURNCMD | TPM_LEFTALIGN | TPM_TOPALIGN, r.left, r.bottom + S(2), 0, g_main, NULL);
	DestroyMenu(menu);
	if (picked >= ID_IFACE_FIRST && picked < ID_IFACE_FIRST + g_state->interfaceCount) {
		copy_str(g_selHost, 64, g_state->interfaces[picked - ID_IFACE_FIRST].id);
		g_userTouched = TRUE;
		apply_state();
	}
}

static void start_server(void) {
	int port = chosen_port();
	if (port < 1024 || port > 65535) {
		MessageBoxW(g_main, T(L"Порт должен быть в диапазоне 1024–65535.", L"The port has to be between 1024 and 65535."), L"notGT", MB_OK | MB_ICONWARNING);
		SetFocus(GetDlgItem(g_main, ID_PORT));
		return;
	}
	EnableWindow(GetDlgItem(g_main, ID_START), FALSE);
	enqueue(ACT_START, g_selHost, L"", port);
}

static void show_window(HWND hwnd) {
	ShowWindow(hwnd, IsIconic(hwnd) ? SW_RESTORE : SW_SHOW);
	SetForegroundWindow(hwnd);
}

static HWND open_tool_window(HWND *slot, const wchar_t *className, const wchar_t *title, int w, int h, DWORD style);

/*
 * Leaves. A server that is running keeps running unless `stopServer`: the
 * launcher's process stays behind to look after it, and the next time the
 * program is started its window shows that server again. With no server
 * running that process ends too.
 */
static void quit(BOOL stopServer) {
	backend_request(&g_backend, L"POST", L"/api/quit", stopServer ? "{\"stop\":true}" : "{\"stop\":false}", FALSE,
		NULL);
	DestroyWindow(g_main);
}

/* The window's close box closes the launcher, not the server. */
static void close_main(void) {
	quit(FALSE);
}

#define TITLE_LOGIN T(L"Вход по паролю", L"Sign-in")
#define TITLE_NETWORK T(L"Сеть и брандмауэр", L"Network and firewall")
#define TITLE_LOG T(L"Журнал сервера", L"Server log")

static int g_logShown = -1;

/* Puts every label in the language in use. The painted texts follow by
 * themselves; the controls and the title bars are told here. */
static void relabel(void) {
	if (!g_main) return;
	SetDlgItemTextW(g_main, ID_START, T(L"Запустить", L"Start"));
	SetDlgItemTextW(g_main, ID_STOP, T(L"Остановить", L"Stop"));
	SetDlgItemTextW(g_main, ID_OPEN, T(L"Открыть панель", L"Open dashboard"));
	SetDlgItemTextW(g_main, ID_COPY, T(L"Копировать", L"Copy"));
	SetDlgItemTextW(g_main, ID_SHOW_LOGIN, T(L"Вход по паролю…", L"Sign-in…"));
	SetDlgItemTextW(g_main, ID_SHOW_NETWORK, T(L"Сеть и брандмауэр…", L"Network and firewall…"));
	SetDlgItemTextW(g_main, ID_SHOW_LOG, T(L"Журнал сервера…", L"Server log…"));
	InvalidateRect(g_main, NULL, TRUE);
	if (g_loginWnd) {
		SetWindowTextW(g_loginWnd, TITLE_LOGIN);
		SetDlgItemTextW(g_loginWnd, ID_LOGIN_SAVE, T(L"Задать администратора", L"Set the administrator"));
		InvalidateRect(g_loginWnd, NULL, TRUE);
	}
	if (g_networkWnd) {
		SetWindowTextW(g_networkWnd, TITLE_NETWORK);
		SetDlgItemTextW(g_networkWnd, ID_NET_CHECK, T(L"Проверить", L"Check"));
		SetDlgItemTextW(g_networkWnd, ID_NET_ALLOW, T(L"Разрешить порт", L"Allow the port"));
		SetDlgItemTextW(g_networkWnd, ID_NET_REMOVE, T(L"Удалить правило", L"Remove the rule"));
		InvalidateRect(g_networkWnd, NULL, TRUE);
	}
	if (g_logWnd) {
		SetWindowTextW(g_logWnd, TITLE_LOG);
		g_logShown = -1; /* the "empty" notice is a text too */
	}
}

/* -------------------------------------------------------------------- tray */

static void update_tray(void) {
	wchar_t tip[128];
	_snwprintf(tip, 128, L"notGT — %ls", status_label());
	tip[127] = L'\0';
	if (!wcscmp(tip, g_tray.szTip)) return;
	copy_str(g_tray.szTip, 128, tip);
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
	copy_str(g_tray.szTip, 128, L"notGT");
	Shell_NotifyIconW(NIM_ADD, &g_tray);
}

static void tray_menu(void) {
	HMENU menu = CreatePopupMenu();
	POINT at;
	AppendMenuW(menu, MF_STRING | (status_is(L"running") ? 0 : MF_GRAYED), ID_TRAY_OPEN, T(L"Открыть панель", L"Open the dashboard"));
	AppendMenuW(menu, MF_STRING, ID_TRAY_SHOW, T(L"Показать лончер", L"Show the launcher"));
	AppendMenuW(menu, MF_SEPARATOR, 0, NULL);
	if (g_state && !can_start()) {
		AppendMenuW(menu, MF_STRING, ID_TRAY_QUIT,
			T(L"Выйти — сервер продолжит работать", L"Quit — the server keeps running"));
		AppendMenuW(menu, MF_STRING, ID_TRAY_STOP_QUIT, T(L"Остановить сервер и выйти", L"Stop the server and quit"));
	} else {
		AppendMenuW(menu, MF_STRING, ID_TRAY_QUIT, T(L"Выйти", L"Quit"));
	}
	GetCursorPos(&at);
	SetForegroundWindow(g_main); /* or the menu would not close on a click elsewhere */
	TrackPopupMenu(menu, TPM_RIGHTBUTTON, at.x, at.y, 0, g_main, NULL);
	DestroyMenu(menu);
}

/* ------------------------------------------------------------ small windows */

/* Paints a window through a memory bitmap: no flicker when the state changes. */
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

/* Matches the title bar to the window where Windows allows it (10 20H1+, 11). */
static void brand_title_bar(HWND hwnd) {
	HMODULE dwm = LoadLibraryW(L"dwmapi.dll");
	typedef HRESULT(WINAPI * SetAttribute)(HWND, DWORD, LPCVOID, DWORD);
	SetAttribute set = dwm ? (SetAttribute)(void *)GetProcAddress(dwm, "DwmSetWindowAttribute") : NULL;
	if (set) {
		BOOL dark = TRUE;
		COLORREF caption = C_BG, ink = C_TEXT;
		set(hwnd, 20, &dark, sizeof(dark)); /* DWMWA_USE_IMMERSIVE_DARK_MODE */
		set(hwnd, 35, &caption, sizeof(caption)); /* DWMWA_CAPTION_COLOR */
		set(hwnd, 36, &ink, sizeof(ink)); /* DWMWA_TEXT_COLOR */
	}
}

/* Opens one of the small windows over the main one, or brings it forward. */
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

/* --- signing in ----------------------------------------------------------- */

#define LOGIN_W 420
#define LOGIN_H 372

static void paint_login(HWND hwnd, HDC dc) {
	RECT all;
	wchar_t line[600];
	GetClientRect(hwnd, &all);
	fill(dc, &all, C_BG);
	login_summary(line, 600);
	text(dc, line, R(20, 16, 380, 36), g_font,
		g_state && g_state->loginEnabled && g_state->loginDefaultPassword ? C_AMBER : C_TEXT, DT_LEFT | DT_WORDBREAK);
	text(dc,
		T(L"Имя и пароль, заданные здесь, — учётная запись администратора; она заменяет admin / admin. "
		  L"Остальные пользователи, их группы и ключи для Companion добавляются в самой панели.",
			L"The name and password set here are the administrator's account; it replaces admin / admin. "
			L"The other users, their groups and the keys for Companion are added in the dashboard itself."),
		R(20, 60, 380, 70), g_fontSmall, C_MUTED, DT_LEFT | DT_WORDBREAK);
	caps(dc, T(L"ИМЯ", L"NAME"), 20, 138);
	well(dc, 20, 156, 380, 34, C_BG);
	caps(dc, T(L"ПАРОЛЬ", L"PASSWORD"), 20, 200);
	well(dc, 20, 218, 380, 34, C_BG);
	text(dc, g_loginMessage, R(20, 312, 380, 52), g_fontSmall, C_LEMON, DT_LEFT | DT_WORDBREAK | DT_END_ELLIPSIS);
}

static void update_login_window(void) {
	if (!g_loginWnd) return;
	set_text(GetDlgItem(g_loginWnd, ID_LOGIN_TOGGLE),
		g_state && !g_state->loginEnabled ? T(L"Включить вход", L"Switch the sign-in on") : T(L"Отключить вход", L"Switch the sign-in off"));
	EnableWindow(GetDlgItem(g_loginWnd, ID_LOGIN_SAVE), g_state != NULL);
	EnableWindow(GetDlgItem(g_loginWnd, ID_LOGIN_TOGGLE), g_state != NULL);
	InvalidateRect(g_loginWnd, NULL, FALSE);
}

static LRESULT CALLBACK login_proc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
	switch (msg) {
	case WM_CREATE:
		make_edit(hwnd, ID_LOGIN_USER, ES_AUTOHSCROLL, 30, 164, 360, 20, g_font);
		make_edit(hwnd, ID_LOGIN_PASS, ES_AUTOHSCROLL | ES_PASSWORD, 30, 226, 360, 20, g_font);
		SendDlgItemMessageW(hwnd, ID_LOGIN_USER, EM_SETLIMITTEXT, 64, 0);
		SendDlgItemMessageW(hwnd, ID_LOGIN_PASS, EM_SETLIMITTEXT, 128, 0);
		make_button(hwnd, ID_LOGIN_SAVE, L"", BTN_PRIMARY, 20, 266, 206, 36);
		make_button(hwnd, ID_LOGIN_TOGGLE, L"", BTN_NORMAL, 234, 266, 166, 36);
		if (g_state && !wcscmp(g_state->loginSource, L"launcher")) {
			SetDlgItemTextW(hwnd, ID_LOGIN_USER, g_state->loginUser);
		}
		g_loginMessage[0] = L'\0';
		g_loginWnd = hwnd;
		relabel();
		update_login_window();
		return 0;
	case WM_COMMAND:
		if (LOWORD(wp) == ID_LOGIN_SAVE || LOWORD(wp) == IDOK) {
			wchar_t user[128], pass[160];
			GetDlgItemTextW(hwnd, ID_LOGIN_USER, user, 128);
			GetDlgItemTextW(hwnd, ID_LOGIN_PASS, pass, 160);
			if (!user[0] || !pass[0]) {
				copy_str(g_loginMessage, 512, T(L"Укажите имя и пароль.", L"Give a name and a password."));
			} else {
				copy_str(g_loginMessage, 512, L"");
				enqueue(ACT_LOGIN_SET, user, pass, 0);
				SetDlgItemTextW(hwnd, ID_LOGIN_PASS, L"");
			}
			SecureZeroMemory(pass, sizeof(pass));
			InvalidateRect(hwnd, NULL, FALSE);
		} else if (LOWORD(wp) == ID_LOGIN_TOGGLE) {
			enqueue(g_state && !g_state->loginEnabled ? ACT_LOGIN_DEFAULT : ACT_LOGIN_OFF, L"", L"", 0);
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
		paint_buffered(hwnd, paint_login);
		return 0;
	case WM_DESTROY:
		g_loginWnd = NULL;
		return 0;
	}
	return DefWindowProcW(hwnd, msg, wp, lp);
}

/* --- network and firewall ------------------------------------------------ */

#define NET_W 480
#define NET_H 420

static void paint_network(HWND hwnd, HDC dc) {
	RECT all;
	wchar_t line[300];
	GetClientRect(hwnd, &all);
	fill(dc, &all, C_BG);
	if (!g_state) line[0] = L'\0';
	else if (!g_state->fwSupported) copy_str(line, 300, T(L"Правило брандмауэра создаётся только в Windows.", L"A firewall rule can only be made on Windows."));
	else if (g_state->fwRuleExists) _snwprintf(line, 300, T(L"Правило «%ls» есть.", L"The rule “%ls” exists."), g_state->fwRuleName);
	else _snwprintf(line, 300, T(L"Правила брандмауэра для порта %d нет.", L"There is no firewall rule for port %d."), g_state->fwPort);
	line[299] = L'\0';
	text(dc, line, R(20, 16, 440, 20), g_fontBold, C_TEXT, DT_LEFT | DT_SINGLELINE | DT_END_ELLIPSIS);
	text(dc,
		T(L"Если панель открывается на этом компьютере, но бесконечно грузится с другого устройства — почти всегда "
		  L"виноват брандмауэр Windows: он не пускает входящие подключения. «Разрешить порт» добавляет правило во "
		  L"всех профилях сети (нужны права администратора).",
			L"If the dashboard opens on this computer but never loads from another device, it is almost always "
			L"Windows Firewall: it does not let incoming connections in. “Allow the port” adds a rule for every "
			L"network profile (administrator rights are needed)."),
		R(20, 42, 440, 70), g_fontSmall, C_MUTED, DT_LEFT | DT_WORDBREAK);
	well(dc, 20, 168, 440, 232, C_BG);
}

static void update_network_window(void) {
	BOOL ready;
	if (!g_networkWnd) return;
	ready = g_state != NULL && !g_networkBusy;
	EnableWindow(GetDlgItem(g_networkWnd, ID_NET_CHECK), ready);
	EnableWindow(GetDlgItem(g_networkWnd, ID_NET_ALLOW), ready && g_state->fwSupported && !g_state->fwRuleExists);
	EnableWindow(GetDlgItem(g_networkWnd, ID_NET_REMOVE), ready && g_state->fwSupported && g_state->fwRuleExists);
	{
		HWND result = GetDlgItem(g_networkWnd, ID_NET_RESULT);
		RECT box;
		TEXTMETRICW metrics;
		HDC dc = GetDC(result);
		HFONT old = (HFONT)SelectObject(dc, g_fontSmall);
		GetTextMetricsW(dc, &metrics);
		SelectObject(dc, old);
		ReleaseDC(result, dc);
		set_text(result, g_networkMessage);
		GetClientRect(result, &box);
		ShowScrollBar(result, SB_VERT,
			(int)SendMessageW(result, EM_GETLINECOUNT, 0, 0) * metrics.tmHeight > box.bottom);
	}
	InvalidateRect(g_networkWnd, NULL, FALSE);
}

static void network_action(ActionKind kind, const wchar_t *waiting) {
	g_networkBusy = TRUE;
	copy_str(g_networkMessage, 2048, waiting);
	enqueue(kind, L"", L"", g_state ? chosen_port() : 9090);
	update_network_window();
}

static LRESULT CALLBACK network_proc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
	switch (msg) {
	case WM_CREATE:
		make_button(hwnd, ID_NET_CHECK, L"", BTN_PRIMARY, 20, 120, 128, 34);
		make_button(hwnd, ID_NET_ALLOW, L"", BTN_NORMAL, 156, 120, 148, 34);
		make_button(hwnd, ID_NET_REMOVE, L"", BTN_NORMAL, 312, 120, 148, 34);
		make_edit(hwnd, ID_NET_RESULT, ES_MULTILINE | ES_READONLY | ES_AUTOVSCROLL | WS_VSCROLL, 30, 176, 424, 216,
			g_fontSmall);
		g_networkWnd = hwnd;
		relabel();
		update_network_window();
		return 0;
	case WM_COMMAND:
		if (LOWORD(wp) == ID_NET_CHECK) network_action(ACT_DIAGNOSE, T(L"Проверяю…", L"Checking…"));
		else if (LOWORD(wp) == ID_NET_ALLOW)
			network_action(ACT_FW_ALLOW, T(L"Добавляю правило… Windows может спросить разрешение.", L"Adding the rule… Windows may ask for permission."));
		else if (LOWORD(wp) == ID_NET_REMOVE)
			network_action(ACT_FW_REMOVE, T(L"Удаляю правило… Windows может спросить разрешение.", L"Removing the rule… Windows may ask for permission."));
		else if (LOWORD(wp) == IDCANCEL) DestroyWindow(hwnd);
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
		paint_buffered(hwnd, paint_network);
		return 0;
	case WM_DESTROY:
		g_networkWnd = NULL;
		return 0;
	}
	return DefWindowProcW(hwnd, msg, wp, lp);
}

/* --- the server log ------------------------------------------------------- */

static void paint_log(HWND hwnd, HDC dc) {
	RECT all;
	GetClientRect(hwnd, &all);
	fill(dc, &all, C_WELL);
}

static void update_log_window(void) {
	HWND edit;
	if (!g_logWnd || !g_state || g_state->logCount == g_logShown) return;
	g_logShown = g_state->logCount;
	edit = GetDlgItem(g_logWnd, ID_LOG_TEXT);
	SetWindowTextW(edit, g_state->logs && g_state->logs[0] ? g_state->logs : T(L"Журнал пуст: сервер ещё не запускался.", L"The log is empty: the server has not been started yet."));
	SendMessageW(edit, EM_SETSEL, (WPARAM)-1, (LPARAM)-1);
	SendMessageW(edit, WM_VSCROLL, SB_BOTTOM, 0);
}

static LRESULT CALLBACK log_proc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
	switch (msg) {
	case WM_CREATE:
		make_edit(hwnd, ID_LOG_TEXT, ES_MULTILINE | ES_READONLY | ES_AUTOVSCROLL | WS_VSCROLL, 0, 0, 10, 10,
			g_fontMono);
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

/* ----------------------------------------------- answers to what was asked */

static void handle_result(ActionResult *result) {
	const wchar_t *message = json_str(result->json, L"message");
	const wchar_t *silent = T(L"Лончер не ответил. Попробуйте ещё раз.", L"The launcher did not answer. Try again.");

	switch (result->kind) {
	case ACT_LANG:
		g_langPending = FALSE; /* from here on the backend's answers are in it */
		break;
	case ACT_START:
	case ACT_STOP:
		/* What happened shows in the state; only a refusal needs words. */
		if (result->status >= 400 && result->status != 409) {
			const wchar_t *why = *json_str(result->json, L"error") ? json_str(result->json, L"error")
																  : json_str(result->json, L"statusText");
			if (*why) MessageBoxW(g_main, why, L"notGT", MB_OK | MB_ICONWARNING);
		}
		break;
	case ACT_LOGIN_SET:
	case ACT_LOGIN_OFF:
	case ACT_LOGIN_DEFAULT:
		copy_str(g_loginMessage, 512, result->status == 0 ? silent : message);
		update_login_window();
		break;
	case ACT_FW_ALLOW:
	case ACT_FW_REMOVE:
		g_networkBusy = FALSE;
		copy_str(g_networkMessage, 2048, result->status == 0 ? silent : message);
		update_network_window();
		break;
	case ACT_DIAGNOSE: {
		const JVal *verdict = json_get(result->json, L"verdict");
		size_t used = 0;
		g_networkBusy = FALSE;
		g_networkMessage[0] = L'\0';
		for (const JVal *item = verdict ? verdict->child : NULL; item; item = item->next) {
			const wchar_t *level = json_str(item, L"level");
			const wchar_t *mark = !wcscmp(level, L"ok") ? L"\x2713 " : !wcscmp(level, L"info") ? L"\x2022 " : L"! ";
			int wrote = _snwprintf(g_networkMessage + used, 2048 - used, L"%ls%ls\r\n\r\n", mark, json_str(item, L"text"));
			if (wrote < 0) break;
			used += (size_t)wrote;
		}
		g_networkMessage[2047] = L'\0';
		if (!g_networkMessage[0]) copy_str(g_networkMessage, 2048, result->status == 0 ? silent : T(L"Замечаний нет.", L"Nothing to report."));
		update_network_window();
		break;
	}
	}
	json_free(result->json);
	free(result);
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

/* One window per step, each given a moment to draw itself first. */
static void snapshot_step(int step) {
	const DWORD fixed = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU;
	switch (step) {
	case 0:
		save_bmp(g_main, L"main");
		open_tool_window(&g_loginWnd, L"notGTLauncherLogin", TITLE_LOGIN, LOGIN_W, LOGIN_H, fixed);
		break;
	case 1:
		save_bmp(g_loginWnd, L"login");
		DestroyWindow(g_loginWnd);
		open_tool_window(&g_networkWnd, L"notGTLauncherNetwork", TITLE_NETWORK, NET_W, NET_H, fixed);
		SendMessageW(g_networkWnd, WM_COMMAND, ID_NET_CHECK, 0);
		break;
	case 2:
		save_bmp(g_networkWnd, L"network");
		DestroyWindow(g_networkWnd);
		open_tool_window(&g_logWnd, L"notGTLauncherLog", TITLE_LOG, 640, 420, WS_OVERLAPPEDWINDOW);
		break;
	case 3:
		save_bmp(g_logWnd, L"log");
		DestroyWindow(g_main);
		return;
	}
	SetTimer(g_main, (UINT_PTR)(1001 + step), step == 1 ? 6000 : 700, NULL);
}

/* --------------------------------------------------------- the main window */

static void paint_main_window(HWND hwnd, HDC dc) {
	(void)hwnd;
	paint_main(dc);
}

static UINT g_taskbarCreated;

static LRESULT CALLBACK main_proc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
	const DWORD fixed = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU;

	if (msg == g_taskbarCreated && g_taskbarCreated && !g_snapshotDir[0]) {
		add_tray(); /* Explorer was restarted and forgot the icon */
		return 0;
	}
	switch (msg) {
	case WM_CREATE:
		g_main = hwnd;
		make_button(hwnd, ID_IFACE, L"", BTN_SELECT, 34, 220, 292, 34);
		make_edit(hwnd, ID_PORT, ES_NUMBER | ES_AUTOHSCROLL, 344, 228, 92, 20, g_font);
		SendDlgItemMessageW(hwnd, ID_PORT, EM_SETLIMITTEXT, 5, 0);
		make_button(hwnd, ID_START, L"", BTN_PRIMARY, 34, 268, 132, 36);
		make_button(hwnd, ID_STOP, L"", BTN_NORMAL, 174, 268, 132, 36);
		make_button(hwnd, ID_OPEN, L"", BTN_NORMAL, 314, 268, 132, 36);
		make_edit(hwnd, ID_URL, ES_READONLY | ES_AUTOHSCROLL, 44, 368, 284, 20, g_font);
		make_button(hwnd, ID_COPY, L"", BTN_NORMAL, 346, 360, 100, 34);
		make_button(hwnd, ID_SHOW_LOGIN, L"", BTN_GHOST, 20, 496, 140, 30);
		make_button(hwnd, ID_SHOW_NETWORK, L"", BTN_GHOST, 164, 496, 160, 30);
		make_button(hwnd, ID_SHOW_LOG, L"", BTN_GHOST, 328, 496, 132, 30);
		make_button(hwnd, ID_LANG_RU, L"RU", BTN_LANG, 384, 29, 36, 22);
		make_button(hwnd, ID_LANG_EN, L"EN", BTN_LANG, 424, 29, 36, 22);
		relabel();
		apply_state();
		return 0;
	case WM_APP_STATE:
		if (lp) {
			AppState *first = g_state;
			state_free(g_state);
			g_state = (AppState *)lp;
			g_missed = 0;
			apply_state();
			if (!first && g_snapshotDir[0]) SetTimer(hwnd, 1000, 700, NULL);
		} else if (++g_missed > 3) {
			state_free(g_state);
			g_state = NULL;
			apply_state();
		}
		return 0;
	case WM_APP_RESULT:
		handle_result((ActionResult *)lp);
		return 0;
	case WM_TIMER:
		if (wp >= 1000 && wp <= 1004) {
			KillTimer(hwnd, wp);
			snapshot_step((int)wp - 1000);
		}
		return 0;
	case WM_APP_TRAY:
		if (lp == WM_LBUTTONUP || lp == WM_LBUTTONDBLCLK) show_window(hwnd);
		else if (lp == WM_RBUTTONUP || lp == WM_CONTEXTMENU) tray_menu();
		return 0;
	case WM_COMMAND:
		switch (LOWORD(wp)) {
		case ID_IFACE:
			choose_interface((HWND)lp);
			break;
		case ID_PORT:
			if (HIWORD(wp) == EN_CHANGE && GetFocus() == (HWND)lp) {
				wchar_t url[600];
				g_userTouched = TRUE;
				dashboard_url(url, 600);
				set_text(GetDlgItem(hwnd, ID_URL), url);
			}
			break;
		case IDOK: /* Enter */
			if (can_start()) start_server();
			break;
		case ID_START:
			start_server();
			break;
		case ID_STOP:
			EnableWindow(GetDlgItem(hwnd, ID_STOP), FALSE);
			enqueue(ACT_STOP, L"", L"", 0);
			break;
		case ID_OPEN:
		case ID_TRAY_OPEN:
			open_dashboard();
			break;
		case ID_COPY: {
			wchar_t url[600];
			GetDlgItemTextW(hwnd, ID_URL, url, 600);
			copy_to_clipboard(hwnd, url);
			break;
		}
		case ID_SHOW_LOGIN:
			open_tool_window(&g_loginWnd, L"notGTLauncherLogin", TITLE_LOGIN, LOGIN_W, LOGIN_H, fixed);
			break;
		case ID_SHOW_NETWORK:
			open_tool_window(&g_networkWnd, L"notGTLauncherNetwork", TITLE_NETWORK, NET_W, NET_H, fixed);
			break;
		case ID_SHOW_LOG:
			open_tool_window(&g_logWnd, L"notGTLauncherLog", TITLE_LOG, 640, 420, WS_OVERLAPPEDWINDOW);
			break;
		case ID_TRAY_SHOW:
			show_window(hwnd);
			break;
		case ID_TRAY_QUIT:
			quit(FALSE);
			break;
		case ID_TRAY_STOP_QUIT:
			quit(TRUE);
			break;
		case ID_LANG_RU:
		case ID_LANG_EN:
			if ((LOWORD(wp) == ID_LANG_EN) != (g_lang == 1)) {
				g_lang = LOWORD(wp) == ID_LANG_EN;
				g_langPending = TRUE;
				relabel();
				apply_state();
				enqueue(ACT_LANG, g_lang ? L"en" : L"ru", L"", 0);
			}
			break;
		}
		return 0;
	case WM_DRAWITEM:
		draw_button((const DRAWITEMSTRUCT *)lp, ((const DRAWITEMSTRUCT *)lp)->CtlID >= ID_SHOW_LOGIN ? C_BG : C_CARD);
		return TRUE;
	case WM_CTLCOLOREDIT:
	case WM_CTLCOLORSTATIC:
		return edit_colors((HDC)wp);
	case WM_ERASEBKGND:
		return 1;
	case WM_PAINT:
		paint_buffered(hwnd, paint_main_window);
		return 0;
	case WM_CLOSE:
		close_main();
		return 0;
	case WM_ENDSESSION:
		/* Windows is shutting down: let the server go down in order. */
		if (wp) backend_request(&g_backend, L"POST", L"/api/quit", "{\"stop\":true}", FALSE, NULL);
		return 0;
	case WM_DESTROY:
		if (!g_snapshotDir[0]) Shell_NotifyIconW(NIM_DELETE, &g_tray);
		PostQuitMessage(0);
		return 0;
	}
	return DefWindowProcW(hwnd, msg, wp, lp);
}

/* ------------------------------------------------------------------- start */

static BOOL is_file(const wchar_t *p) {
	DWORD attrs = GetFileAttributesW(p);
	return attrs != INVALID_FILE_ATTRIBUTES && (attrs & FILE_ATTRIBUTE_DIRECTORY) == 0;
}

static BOOL is_dir(const wchar_t *p) {
	DWORD attrs = GetFileAttributesW(p);
	return attrs != INVALID_FILE_ATTRIBUTES && (attrs & FILE_ATTRIBUTE_DIRECTORY) != 0;
}

static int fail(const wchar_t *message) {
	MessageBoxW(NULL, message, T(L"notGT — ошибка запуска", L"notGT — could not start"), MB_OK | MB_ICONERROR | MB_SETFOREGROUND | MB_TOPMOST);
	return 1;
}

/* Names what is missing from the unpacked package and bails out. */
static int fail_missing(const wchar_t *what, const wchar_t *path) {
	wchar_t *message = (wchar_t *)malloc((wcslen(path) + 512) * sizeof(wchar_t));
	if (!message) return 1;
	wsprintfW(message,
		T(L"Не найден %ls:\n\n%ls\n\n"
		  L"Похоже, ZIP-архив распакован не полностью. Распакуйте его целиком "
		  L"в отдельную папку и запустите «notGT Launcher.exe» из неё.",
			L"%ls is missing:\n\n%ls\n\n"
			L"The ZIP archive seems not to be unpacked completely. Unpack all of it "
			L"into a folder of its own and start “notGT Launcher.exe” from there."),
		what, path);
	fail(message);
	free(message);
	return 1;
}

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

int wmain(int argc, wchar_t **argv) {
	const DWORD style = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX;
	const wchar_t *controlUrl = NULL;
	static wchar_t dir[NOTGT_MAX_PATH], node[NOTGT_MAX_PATH], script[NOTGT_MAX_PATH], app[NOTGT_MAX_PATH];
	static wchar_t runtime[NOTGT_MAX_PATH];
	BOOL attached = FALSE;
	wchar_t error[1024] = L"";
	RECT frame;
	HDC screen;
	MSG msg;
	HANDLE threads[2], once;
	int dpiOverride = 0;

	g_instance = GetModuleHandleW(NULL);
	g_lang = PRIMARYLANGID(GetUserDefaultUILanguage()) != LANG_RUSSIAN;
	for (int i = 1; i < argc; i++) {
		if (!wcscmp(argv[i], L"--control-url") && i + 1 < argc) controlUrl = argv[++i];
		else if (!wcscmp(argv[i], L"--snapshot") && i + 1 < argc) copy_str(g_snapshotDir, MAX_PATH, argv[++i]);
		else if (!wcscmp(argv[i], L"--dpi") && i + 1 < argc) dpiOverride = _wtoi(argv[++i]);
	}

	/* A second double click shows the window that is already there. */
	once = CreateMutexW(NULL, FALSE, L"Local\\notGT-Launcher");
	if (once && GetLastError() == ERROR_ALREADY_EXISTS && !g_snapshotDir[0]) {
		HWND existing = FindWindowW(L"notGTLauncher", NULL);
		if (existing) {
			ShowWindow(existing, IsIconic(existing) ? SW_RESTORE : SW_SHOW);
			SetForegroundWindow(existing);
		}
		return 0;
	}

	if (controlUrl) {
		char narrow[128];
		WideCharToMultiByte(CP_UTF8, 0, controlUrl, -1, narrow, sizeof(narrow), NULL, NULL);
		g_backend.port = backend_port_of(narrow);
		if (!g_backend.port) return fail(T(L"--control-url: нужен адрес вида http://127.0.0.1:<порт>", L"--control-url: an address like http://127.0.0.1:<port> is needed"));
	} else {
		DWORD len = GetModuleFileNameW(NULL, dir, NOTGT_MAX_PATH);
		wchar_t *lastSep;
		if (len == 0 || len >= NOTGT_MAX_PATH) {
			return fail(T(L"Не удалось определить папку программы. Запустите «notGT Launcher.exe» "
						  L"из распакованной папки notGT-win-x64.",
				L"Could not tell which folder the program is in. Start “notGT Launcher.exe” "
				L"from the unpacked notGT-win-x64 folder."));
		}
		lastSep = wcsrchr(dir, L'\\');
		if (lastSep) *lastSep = L'\0';
		else wcscpy(dir, L".");
		_snwprintf(node, NOTGT_MAX_PATH, L"%ls\\node\\node.exe", dir);
		_snwprintf(script, NOTGT_MAX_PATH, L"%ls\\launcher\\index.mjs", dir);
		_snwprintf(app, NOTGT_MAX_PATH, L"%ls\\app", dir);
		if (!is_file(node)) return fail_missing(T(L"файл node\\node.exe", L"The file node\\node.exe"), node);
		if (!is_file(script)) return fail_missing(T(L"файл launcher\\index.mjs", L"The file launcher\\index.mjs"), script);
		if (!is_dir(app)) return fail_missing(T(L"папка app", L"The folder app"), app);
		/* A launcher left running with its server is the one to talk to;
		 * otherwise a new one is started. */
		_snwprintf(runtime, NOTGT_MAX_PATH, L"%ls\\launcher\\launcher-runtime.json", dir);
		attached = backend_attach(&g_backend, runtime);
		if (!attached && !backend_start(&g_backend, node, script, app, dir, error, 1024)) {
			backend_close(&g_backend);
			return fail(error);
		}
	}
	if (!attached && !backend_connect(&g_backend)) {
		backend_close(&g_backend);
		return fail(T(L"Не удалось открыть соединение со служебным процессом notGT.", L"Could not connect to notGT's service process."));
	}

	screen = GetDC(NULL);
	g_dpi = dpiOverride > 0 ? dpiOverride : GetDeviceCaps(screen, LOGPIXELSX);
	ReleaseDC(NULL, screen);
	g_font = make_font(13, FW_NORMAL, L"Segoe UI");
	g_fontBold = make_font(13, FW_SEMIBOLD, L"Segoe UI");
	g_fontSmall = make_font(12, FW_NORMAL, L"Segoe UI");
	g_fontCaps = make_font(11, FW_SEMIBOLD, L"Segoe UI");
	g_fontMono = make_font(12, FW_NORMAL, L"Consolas");
	g_brushBg = CreateSolidBrush(C_BG);
	g_brushWell = CreateSolidBrush(C_WELL);
	g_icon = (HICON)LoadImageW(g_instance, MAKEINTRESOURCEW(1), IMAGE_ICON, GetSystemMetrics(SM_CXICON),
		GetSystemMetrics(SM_CYICON), 0);
	g_iconSmall = (HICON)LoadImageW(g_instance, MAKEINTRESOURCEW(1), IMAGE_ICON, GetSystemMetrics(SM_CXSMICON),
		GetSystemMetrics(SM_CYSMICON), 0);
	load_logo();

	g_quit = CreateEventW(NULL, TRUE, FALSE, NULL);
	g_pollNow = CreateEventW(NULL, FALSE, FALSE, NULL);
	g_actionReady = CreateEventW(NULL, FALSE, FALSE, NULL);
	InitializeCriticalSection(&g_actionLock);
	g_taskbarCreated = RegisterWindowMessageW(L"TaskbarCreated");

	register_class(L"notGTLauncher", main_proc);
	register_class(L"notGTLauncherLogin", login_proc);
	register_class(L"notGTLauncherNetwork", network_proc);
	register_class(L"notGTLauncherLog", log_proc);

	SetRect(&frame, 0, 0, S(MAIN_W), S(MAIN_H));
	AdjustWindowRectEx(&frame, style, FALSE, 0);
	CreateWindowExW(0, L"notGTLauncher", L"notGT", style, CW_USEDEFAULT, CW_USEDEFAULT, frame.right - frame.left,
		frame.bottom - frame.top, NULL, NULL, g_instance, NULL);
	if (!g_main) {
		backend_close(&g_backend);
		return fail(T(L"Не удалось создать окно.", L"The window could not be created."));
	}
	brand_title_bar(g_main);
	if (!g_snapshotDir[0]) add_tray();
	ShowWindow(g_main, SW_SHOW);
	UpdateWindow(g_main);

	threads[0] = CreateThread(NULL, 0, poll_thread, NULL, 0, NULL);
	threads[1] = CreateThread(NULL, 0, action_thread, NULL, 0, NULL);

	while (GetMessageW(&msg, NULL, 0, 0) > 0) {
		/* Tab, Enter and Esc work in every window as they do in a dialog. */
		HWND top = GetAncestor(msg.hwnd, GA_ROOT);
		if (top && (top == g_main || top == g_loginWnd || top == g_networkWnd || top == g_logWnd) &&
			IsDialogMessageW(top, &msg)) {
			continue;
		}
		TranslateMessage(&msg);
		DispatchMessageW(&msg);
	}

	SetEvent(g_quit);
	WaitForMultipleObjects(2, threads, TRUE, 3000);
	backend_close(&g_backend);
	state_free(g_state);
	if (once) CloseHandle(once);
	return 0;
}
