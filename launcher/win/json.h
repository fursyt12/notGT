/*
 * A JSON reader, as small as the launcher needs: it parses the answers of the
 * launcher's own control API (launcher/index.mjs) into a tree and looks values
 * up by key. Strings come out as UTF-16, ready for the Win32 API.
 *
 * Header-only on purpose, so the launcher stays a one-line compile.
 */
#ifndef NOTGT_JSON_H
#define NOTGT_JSON_H

#include <stdlib.h>
#include <string.h>
#include <windows.h>

typedef enum { J_NULL, J_BOOL, J_NUM, J_STR, J_ARR, J_OBJ } JType;

typedef struct JVal {
	JType type;
	double num; /* J_NUM, and 0/1 for J_BOOL */
	wchar_t *str; /* J_STR */
	wchar_t *key; /* set on the members of an object */
	struct JVal *child; /* first element / member */
	struct JVal *next; /* next sibling */
} JVal;

typedef struct {
	const char *p;
	BOOL failed;
} JParser;

static void json_free(JVal *v) {
	while (v) {
		JVal *next = v->next;
		json_free(v->child);
		free(v->str);
		free(v->key);
		free(v);
		v = next;
	}
}

static void json_skip(JParser *ps) {
	while (*ps->p == ' ' || *ps->p == '\t' || *ps->p == '\n' || *ps->p == '\r') ps->p++;
}

static int json_hex4(const char *s) {
	int value = 0;
	for (int i = 0; i < 4; i++) {
		char c = s[i];
		value <<= 4;
		if (c >= '0' && c <= '9') value |= c - '0';
		else if (c >= 'a' && c <= 'f') value |= c - 'a' + 10;
		else if (c >= 'A' && c <= 'F') value |= c - 'A' + 10;
		else return -1;
	}
	return value;
}

/* Appends a code point to a UTF-8 buffer. */
static size_t json_utf8(char *out, unsigned cp) {
	if (cp < 0x80) {
		out[0] = (char)cp;
		return 1;
	}
	if (cp < 0x800) {
		out[0] = (char)(0xC0 | (cp >> 6));
		out[1] = (char)(0x80 | (cp & 0x3F));
		return 2;
	}
	if (cp < 0x10000) {
		out[0] = (char)(0xE0 | (cp >> 12));
		out[1] = (char)(0x80 | ((cp >> 6) & 0x3F));
		out[2] = (char)(0x80 | (cp & 0x3F));
		return 3;
	}
	out[0] = (char)(0xF0 | (cp >> 18));
	out[1] = (char)(0x80 | ((cp >> 12) & 0x3F));
	out[2] = (char)(0x80 | ((cp >> 6) & 0x3F));
	out[3] = (char)(0x80 | (cp & 0x3F));
	return 4;
}

/* Reads a string literal; returns it as a newly allocated UTF-16 string. */
static wchar_t *json_string(JParser *ps) {
	if (*ps->p != '"') {
		ps->failed = TRUE;
		return NULL;
	}
	const char *s = ++ps->p;
	/* An escape never decodes to more bytes than it takes, so the length of
	 * the literal bounds the length of the result. */
	size_t cap = 0;
	for (const char *q = s; *q && *q != '"'; q++) {
		if (*q == '\\' && q[1]) q++;
		cap++;
	}
	char *buf = (char *)malloc(cap * 4 + 4);
	size_t n = 0;
	if (!buf) {
		ps->failed = TRUE;
		return NULL;
	}
	while (*s && *s != '"') {
		if (*s != '\\') {
			buf[n++] = *s++;
			continue;
		}
		s++;
		switch (*s) {
		case 'n': buf[n++] = '\n'; s++; break;
		case 't': buf[n++] = '\t'; s++; break;
		case 'r': buf[n++] = '\r'; s++; break;
		case 'b': buf[n++] = '\b'; s++; break;
		case 'f': buf[n++] = '\f'; s++; break;
		case 'u': {
			int cp = json_hex4(s + 1);
			if (cp < 0) {
				free(buf);
				ps->failed = TRUE;
				return NULL;
			}
			s += 5;
			/* A surrogate pair is one character written as two escapes. */
			if (cp >= 0xD800 && cp <= 0xDBFF && s[0] == '\\' && s[1] == 'u') {
				int low = json_hex4(s + 2);
				if (low >= 0xDC00 && low <= 0xDFFF) {
					cp = 0x10000 + ((cp - 0xD800) << 10) + (low - 0xDC00);
					s += 6;
				}
			}
			n += json_utf8(buf + n, (unsigned)cp);
			break;
		}
		case '\0':
			break;
		default:
			buf[n++] = *s++; /* \" \\ \/ */
		}
	}
	if (*s != '"') {
		free(buf);
		ps->failed = TRUE;
		return NULL;
	}
	ps->p = s + 1;
	buf[n] = '\0';
	int wide = MultiByteToWideChar(CP_UTF8, 0, buf, (int)n, NULL, 0);
	wchar_t *out = (wchar_t *)malloc(((size_t)wide + 1) * sizeof(wchar_t));
	if (out) {
		MultiByteToWideChar(CP_UTF8, 0, buf, (int)n, out, wide);
		out[wide] = L'\0';
	} else {
		ps->failed = TRUE;
	}
	free(buf);
	return out;
}

static JVal *json_value(JParser *ps, int depth);

static JVal *json_container(JParser *ps, int depth, BOOL object) {
	JVal *self = (JVal *)calloc(1, sizeof(JVal));
	JVal **tail;
	char close = object ? '}' : ']';
	if (!self) {
		ps->failed = TRUE;
		return NULL;
	}
	self->type = object ? J_OBJ : J_ARR;
	tail = &self->child;
	ps->p++;
	json_skip(ps);
	if (*ps->p == close) {
		ps->p++;
		return self;
	}
	while (!ps->failed) {
		wchar_t *key = NULL;
		JVal *item;
		json_skip(ps);
		if (object) {
			key = json_string(ps);
			json_skip(ps);
			if (ps->failed || *ps->p != ':') {
				free(key);
				ps->failed = TRUE;
				break;
			}
			ps->p++;
		}
		item = json_value(ps, depth + 1);
		if (!item) {
			free(key);
			ps->failed = TRUE;
			break;
		}
		item->key = key;
		*tail = item;
		tail = &item->next;
		json_skip(ps);
		if (*ps->p == ',') {
			ps->p++;
			continue;
		}
		if (*ps->p == close) {
			ps->p++;
			return self;
		}
		ps->failed = TRUE;
	}
	json_free(self);
	return NULL;
}

static JVal *json_value(JParser *ps, int depth) {
	JVal *v;
	json_skip(ps);
	if (depth > 64) {
		ps->failed = TRUE;
		return NULL;
	}
	if (*ps->p == '{') return json_container(ps, depth, TRUE);
	if (*ps->p == '[') return json_container(ps, depth, FALSE);
	v = (JVal *)calloc(1, sizeof(JVal));
	if (!v) {
		ps->failed = TRUE;
		return NULL;
	}
	if (*ps->p == '"') {
		v->type = J_STR;
		v->str = json_string(ps);
	} else if (!strncmp(ps->p, "true", 4)) {
		v->type = J_BOOL;
		v->num = 1;
		ps->p += 4;
	} else if (!strncmp(ps->p, "false", 5)) {
		v->type = J_BOOL;
		ps->p += 5;
	} else if (!strncmp(ps->p, "null", 4)) {
		v->type = J_NULL;
		ps->p += 4;
	} else {
		char *end = NULL;
		v->type = J_NUM;
		v->num = strtod(ps->p, &end);
		if (end == ps->p) ps->failed = TRUE;
		else ps->p = end;
	}
	if (ps->failed) {
		json_free(v);
		return NULL;
	}
	return v;
}

/* Parses a document; NULL when it is not JSON. Free with json_free. */
static JVal *json_parse(const char *text) {
	JParser ps = { text ? text : "", FALSE };
	JVal *root = json_value(&ps, 0);
	if (ps.failed) {
		json_free(root);
		return NULL;
	}
	return root;
}

static const JVal *json_get(const JVal *object, const wchar_t *key) {
	if (!object || object->type != J_OBJ) return NULL;
	for (const JVal *v = object->child; v; v = v->next) {
		if (v->key && !wcscmp(v->key, key)) return v;
	}
	return NULL;
}

static const wchar_t *json_str(const JVal *object, const wchar_t *key) {
	const JVal *v = json_get(object, key);
	return v && v->type == J_STR && v->str ? v->str : L"";
}

static double json_num(const JVal *object, const wchar_t *key, double fallback) {
	const JVal *v = json_get(object, key);
	return v && v->type == J_NUM ? v->num : fallback;
}

static BOOL json_bool(const JVal *object, const wchar_t *key) {
	const JVal *v = json_get(object, key);
	return v && v->type == J_BOOL && v->num != 0;
}

#endif
