/*
 * What Spotify plays, from Windows' System Media Transport Controls (the
 * panel that shows the playing track over the volume flyout).
 *
 * That API is WinRT, made for C++ and C#. From C it is plain COM: an
 * interface is a pointer to a table of functions, the first six of which are
 * IInspectable's. The interface ids and the order of the functions below come
 * from the Windows SDK's metadata (Windows.Foundation.UniversalApiContract
 * .winmd); a wrong slot would call the wrong function, so they are written
 * out with their names.
 *
 * combase.dll is loaded at run time: the program starts on a system without
 * these controls (Windows before 10 1809, wine) and says so instead.
 */
#ifndef KARAOKE_SMTC_H
#define KARAOKE_SMTC_H

#include <windows.h>

typedef struct HSTRING__ *HSTRING;

/* combase.dll */
typedef HRESULT(WINAPI *RoInitializeFn)(int type);
typedef HRESULT(WINAPI *RoGetActivationFactoryFn)(HSTRING classId, REFIID iid, void **factory);
typedef HRESULT(WINAPI *WindowsCreateStringFn)(const wchar_t *text, UINT32 length, HSTRING *out);
typedef HRESULT(WINAPI *WindowsDeleteStringFn)(HSTRING text);
typedef const wchar_t *(WINAPI *WindowsGetStringRawBufferFn)(HSTRING text, UINT32 *length);

static RoInitializeFn p_roInitialize;
static RoGetActivationFactoryFn p_roGetActivationFactory;
static WindowsCreateStringFn p_createString;
static WindowsDeleteStringFn p_deleteString;
static WindowsGetStringRawBufferFn p_stringBuffer;

/* Windows.Media.Control.IGlobalSystemMediaTransportControlsSessionManagerStatics */
static const GUID IID_SessionManagerStatics = { 0x2050c4ee, 0x11a0, 0x57de, { 0xae, 0xd7, 0xc9, 0x7c, 0x70, 0x33, 0x82, 0x45 } };
/* Windows.Foundation.IAsyncInfo */
static const GUID IID_AsyncInfo = { 0x00000036, 0x0000, 0x0000, { 0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46 } };

/* The slots used, by interface (IInspectable takes 0-5). */
enum {
	SLOT_QUERY_INTERFACE = 0,
	SLOT_RELEASE = 2,
	/* IGlobalSystemMediaTransportControlsSessionManagerStatics */
	SLOT_STATICS_REQUEST_ASYNC = 6,
	/* IGlobalSystemMediaTransportControlsSessionManager */
	SLOT_MANAGER_GET_SESSIONS = 7,
	/* IGlobalSystemMediaTransportControlsSession */
	SLOT_SESSION_SOURCE_APP = 6,
	SLOT_SESSION_MEDIA_PROPERTIES_ASYNC = 7,
	SLOT_SESSION_TIMELINE = 8,
	SLOT_SESSION_PLAYBACK_INFO = 9,
	/* IGlobalSystemMediaTransportControlsSessionMediaProperties */
	SLOT_PROPERTIES_TITLE = 6,
	SLOT_PROPERTIES_ARTIST = 9,
	/* IGlobalSystemMediaTransportControlsSessionTimelineProperties */
	SLOT_TIMELINE_START = 6,
	SLOT_TIMELINE_END = 7,
	SLOT_TIMELINE_POSITION = 10,
	SLOT_TIMELINE_LAST_UPDATED = 11,
	/* IGlobalSystemMediaTransportControlsSessionPlaybackInfo */
	SLOT_PLAYBACK_STATUS = 7,
	/* Windows.Foundation.IAsyncInfo */
	SLOT_ASYNC_STATUS = 7,
	/* Windows.Foundation.IAsyncOperation`1 */
	SLOT_ASYNC_GET_RESULTS = 8,
	/* Windows.Foundation.Collections.IVectorView`1 */
	SLOT_VECTOR_GET_AT = 6,
	SLOT_VECTOR_SIZE = 7,
};

enum { ASYNC_STARTED = 0, ASYNC_COMPLETED = 1 };
enum { PLAYBACK_PLAYING = 4 };

#define VTABLE(obj) (*(void ***)(obj))
typedef HRESULT(STDMETHODCALLTYPE *GetPtrFn)(void *self, void **out);
typedef HRESULT(STDMETHODCALLTYPE *GetI64Fn)(void *self, INT64 *out);
typedef HRESULT(STDMETHODCALLTYPE *GetI32Fn)(void *self, INT32 *out);
typedef HRESULT(STDMETHODCALLTYPE *GetU32Fn)(void *self, UINT32 *out);
typedef HRESULT(STDMETHODCALLTYPE *GetAtFn)(void *self, UINT32 index, void **out);
typedef HRESULT(STDMETHODCALLTYPE *QueryFn)(void *self, REFIID iid, void **out);
typedef ULONG(STDMETHODCALLTYPE *ReleaseFn)(void *self);

static void com_release(void *obj) {
	if (obj) ((ReleaseFn)VTABLE(obj)[SLOT_RELEASE])(obj);
}

static HRESULT com_get(void *obj, int slot, void **out) {
	*out = NULL;
	return ((GetPtrFn)VTABLE(obj)[slot])(obj, out);
}

/* Waits for an IAsyncOperation to finish and takes its result. */
static void *await_result(void *operation, DWORD timeoutMs) {
	void *info = NULL, *result = NULL;
	INT32 status = ASYNC_STARTED;
	DWORD start = GetTickCount();
	if (!operation) return NULL;
	if (((QueryFn)VTABLE(operation)[SLOT_QUERY_INTERFACE])(operation, &IID_AsyncInfo, &info) != S_OK) return NULL;
	while (((GetI32Fn)VTABLE(info)[SLOT_ASYNC_STATUS])(info, &status) == S_OK && status == ASYNC_STARTED &&
		GetTickCount() - start < timeoutMs)
		Sleep(2);
	com_release(info);
	if (status == ASYNC_COMPLETED) com_get(operation, SLOT_ASYNC_GET_RESULTS, &result);
	return result;
}

/* An HSTRING getter, copied into `out`. */
static void get_text(void *obj, int slot, wchar_t *out, size_t len) {
	HSTRING value = NULL;
	UINT32 n = 0;
	const wchar_t *raw;
	out[0] = L'\0';
	if (((GetPtrFn)VTABLE(obj)[slot])(obj, (void **)&value) != S_OK || !value) return;
	raw = p_stringBuffer(value, &n);
	if (raw) {
		if (n >= len) n = (UINT32)len - 1;
		memcpy(out, raw, n * sizeof(wchar_t));
		out[n] = L'\0';
	}
	p_deleteString(value);
}

/* What a player says it plays. */
typedef struct {
	BOOL found; /* the player has a session at all */
	wchar_t artist[256];
	wchar_t title[256];
	double posMs; /* where it is now, extrapolated from its last report */
	double durationS;
	BOOL playing;
} PlayerState;

static void *g_smtcManager;

/* Gets the session manager; FALSE (with a reason) when there is none. Call it
 * on the thread that reads, once. */
static BOOL smtc_init(wchar_t *why, size_t whyLen) {
	static const wchar_t className[] = L"Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager";
	HMODULE combase = LoadLibraryW(L"combase.dll");
	HSTRING name = NULL;
	void *statics = NULL, *operation = NULL;
	HRESULT hr;

	why[0] = L'\0';
	if (combase) {
		p_roInitialize = (RoInitializeFn)(void *)GetProcAddress(combase, "RoInitialize");
		p_roGetActivationFactory = (RoGetActivationFactoryFn)(void *)GetProcAddress(combase, "RoGetActivationFactory");
		p_createString = (WindowsCreateStringFn)(void *)GetProcAddress(combase, "WindowsCreateString");
		p_deleteString = (WindowsDeleteStringFn)(void *)GetProcAddress(combase, "WindowsDeleteString");
		p_stringBuffer = (WindowsGetStringRawBufferFn)(void *)GetProcAddress(combase, "WindowsGetStringRawBuffer");
	}
	if (!p_roInitialize || !p_roGetActivationFactory || !p_createString || !p_deleteString || !p_stringBuffer) {
		_snwprintf(why, whyLen, L"combase.dll");
		return FALSE;
	}
	p_roInitialize(1); /* RO_INIT_MULTITHREADED */
	if (p_createString(className, (UINT32)wcslen(className), &name) != S_OK) return FALSE;
	hr = p_roGetActivationFactory(name, &IID_SessionManagerStatics, &statics);
	p_deleteString(name);
	if (hr != S_OK || !statics) {
		_snwprintf(why, whyLen, L"0x%08lx", (unsigned long)hr);
		return FALSE;
	}
	com_get(statics, SLOT_STATICS_REQUEST_ASYNC, &operation);
	g_smtcManager = await_result(operation, 5000);
	com_release(operation);
	com_release(statics);
	if (!g_smtcManager) _snwprintf(why, whyLen, L"RequestAsync");
	return g_smtcManager != NULL;
}

/* 100 ns ticks since 1601, like the timeline's LastUpdatedTime. */
static INT64 now_ticks(void) {
	FILETIME ft;
	GetSystemTimePreciseAsFileTime(&ft);
	return ((INT64)ft.dwHighDateTime << 32) | ft.dwLowDateTime;
}

/* Reads the session of the app whose id contains `app` (e.g. "spotify"). */
static BOOL smtc_read(const wchar_t *app, PlayerState *out) {
	void *sessions = NULL, *session = NULL;
	UINT32 count = 0;
	ZeroMemory(out, sizeof(*out));
	if (!g_smtcManager || com_get(g_smtcManager, SLOT_MANAGER_GET_SESSIONS, &sessions) != S_OK || !sessions)
		return FALSE;
	((GetU32Fn)VTABLE(sessions)[SLOT_VECTOR_SIZE])(sessions, &count);
	for (UINT32 i = 0; i < count && !session; i++) {
		void *candidate = NULL;
		wchar_t id[512];
		if (((GetAtFn)VTABLE(sessions)[SLOT_VECTOR_GET_AT])(sessions, i, &candidate) != S_OK || !candidate) continue;
		get_text(candidate, SLOT_SESSION_SOURCE_APP, id, 512);
		CharLowerW(id);
		if (wcsstr(id, app)) session = candidate;
		else com_release(candidate);
	}
	com_release(sessions);
	if (!session) return TRUE;

	out->found = TRUE;
	{
		void *operation = NULL, *properties;
		com_get(session, SLOT_SESSION_MEDIA_PROPERTIES_ASYNC, &operation);
		properties = await_result(operation, 2000);
		com_release(operation);
		if (properties) {
			get_text(properties, SLOT_PROPERTIES_ARTIST, out->artist, 256);
			get_text(properties, SLOT_PROPERTIES_TITLE, out->title, 256);
			com_release(properties);
		}
	}
	{
		void *info = NULL;
		INT32 status = 0;
		if (com_get(session, SLOT_SESSION_PLAYBACK_INFO, &info) == S_OK && info) {
			((GetI32Fn)VTABLE(info)[SLOT_PLAYBACK_STATUS])(info, &status);
			com_release(info);
		}
		out->playing = status == PLAYBACK_PLAYING;
	}
	{
		void *timeline = NULL;
		INT64 start = 0, end = 0, position = 0, updated = 0;
		if (com_get(session, SLOT_SESSION_TIMELINE, &timeline) == S_OK && timeline) {
			((GetI64Fn)VTABLE(timeline)[SLOT_TIMELINE_START])(timeline, &start);
			((GetI64Fn)VTABLE(timeline)[SLOT_TIMELINE_END])(timeline, &end);
			((GetI64Fn)VTABLE(timeline)[SLOT_TIMELINE_POSITION])(timeline, &position);
			((GetI64Fn)VTABLE(timeline)[SLOT_TIMELINE_LAST_UPDATED])(timeline, &updated);
			com_release(timeline);
		}
		/* The position is the one at the moment of the last report; the time
		 * since then is added while it plays. */
		out->posMs = position / 10000.0;
		if (out->playing && updated > 0) {
			INT64 since = now_ticks() - updated;
			if (since > 0) out->posMs += since / 10000.0;
		}
		out->durationS = (end - start) / 1e7;
	}
	com_release(session);
	return TRUE;
}

#endif
