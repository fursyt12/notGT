/*
 * Lyrics: where they come from, the variants of one song, and how those are
 * compared.
 *
 *   LRCLIB    lrclib.net, an open database of synced lyrics, often with a few
 *             timings of one song and many copies of the usual one
 *   NetEase   music.163.com, a big catalogue, Asian music in particular
 *   Musixmatch what Spotify itself shows; needs a token of your own account
 *
 * A song's lyrics come as LRC: "[mm:ss.xx]line", sometimes with a time per
 * word ("<mm:ss.xx>word"). Every source is asked at once; what each finds
 * becomes variants, equal timings are counted as votes for one, and the
 * variants are ranked (see rank_variants).
 */
#ifndef BRIDGE_LYRICS_H
#define BRIDGE_LYRICS_H

#include <math.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>
#include <windows.h>

#include "../../launcher/win/json.h"
#include "net.h"

/* ------------------------------------------------------------------ text */

static wchar_t *wdup(const wchar_t *s) {
	size_t n = wcslen(s ? s : L"");
	wchar_t *out = (wchar_t *)malloc((n + 1) * sizeof(wchar_t));
	if (out) memcpy(out, s ? s : L"", (n + 1) * sizeof(wchar_t));
	return out;
}

static wchar_t *wdupn(const wchar_t *s, size_t n) {
	wchar_t *out = (wchar_t *)malloc((n + 1) * sizeof(wchar_t));
	if (!out) return NULL;
	memcpy(out, s, n * sizeof(wchar_t));
	out[n] = L'\0';
	return out;
}

static BOOL is_word_char(wchar_t c) {
	return c == L'_' || IsCharAlphaNumericW(c);
}

static BOOL is_space(wchar_t c) {
	return c == L' ' || c == L'\t' || c == L'\r' || c == L'\n' || c == 0xA0 || c == 0x3000;
}

/* Letters and digits only, lower case: the text two sources must share to be
 * the same line (or the same name). */
static wchar_t *norm(const wchar_t *s) {
	size_t n = 0;
	wchar_t *out = (wchar_t *)malloc((wcslen(s ? s : L"") + 1) * sizeof(wchar_t));
	if (!out) return NULL;
	for (const wchar_t *c = s ? s : L""; *c; c++)
		if (is_word_char(*c)) out[n++] = *c;
	out[n] = L'\0';
	CharLowerBuffW(out, (DWORD)n);
	return out;
}

static int word_chars(const wchar_t *s) {
	int n = 0;
	for (; s && *s; s++) n += is_word_char(*s);
	return n;
}

/* Trims, and turns runs of white space into one space, in place. */
static void squeeze(wchar_t *s) {
	size_t w = 0;
	BOOL space = TRUE;
	for (size_t r = 0; s[r]; r++) {
		if (is_space(s[r])) {
			if (!space) s[w++] = L' ';
			space = TRUE;
		} else {
			s[w++] = s[r];
			space = FALSE;
		}
	}
	while (w > 0 && s[w - 1] == L' ') w--;
	s[w] = L'\0';
}

static BOOL starts_with_ci(const wchar_t *s, const wchar_t *prefix) {
	return !_wcsnicmp(s, prefix, wcslen(prefix));
}

/*
 * A title as a search term: no "(feat. X)", "[Remastered]", " - Live", "feat. Y".
 */
static void clean_title(const wchar_t *title, wchar_t *out, size_t cap) {
	static const wchar_t *versions[] = { L"remaster", L"live", L"radio", L"single", L"version", L"edit",
		L"mono", L"stereo", L"deluxe" };
	size_t n = 0;
	for (const wchar_t *c = title; *c && n + 1 < cap; c++) {
		/* a bracketed part, up to the first closing bracket */
		if (*c == L'(' || *c == L'[') {
			const wchar_t *end = wcspbrk(c + 1, L")]");
			if (end) {
				c = end;
				out[n++] = L' ';
				continue;
			}
		}
		out[n++] = *c;
	}
	out[n] = L'\0';
	/* " - Remastered 2011" and the like */
	for (wchar_t *c = out; *c; c++) {
		if (is_space(c[0]) && (c[1] == L'-' || c[1] == 0x2013 || c[1] == 0x2014) && c[2] && is_space(c[2])) {
			const wchar_t *word = c + 3;
			while (is_space(*word)) word++;
			for (size_t i = 0; i < sizeof(versions) / sizeof(versions[0]); i++) {
				if (starts_with_ci(word, versions[i])) {
					*c = L'\0';
					break;
				}
			}
			if (!*c) break;
		}
	}
	/* "feat. X" / "ft X" to the end */
	for (wchar_t *c = out; *c; c++) {
		BOOL boundary = c == out || !is_word_char(c[-1]);
		size_t len = starts_with_ci(c, L"feat") ? 4 : starts_with_ci(c, L"ft") ? 2 : 0;
		if (boundary && len) {
			const wchar_t *after = c + len;
			if (*after == L'.') after++;
			if (is_space(*after)) {
				*c = L'\0';
				break;
			}
		}
	}
	squeeze(out);
}

/* The artists of "A, B & C feat. D": up to 8 names, trimmed, written into `names`. */
static int split_artists(const wchar_t *artist, wchar_t names[8][128]) {
	int count = 0;
	size_t n = 0;
	wchar_t cur[128];
	for (const wchar_t *c = artist;; c++) {
		size_t skip = 0;
		if (!*c || wcschr(L",;/&", *c)) skip = 1;
		else if (!wcsncmp(c, L" x ", 3)) skip = 3;
		else if (!wcsncmp(c, L" feat. ", 7)) skip = 7;
		else if (!wcsncmp(c, L" feat ", 6)) skip = 6;
		if (skip) {
			cur[n] = L'\0';
			squeeze(cur);
			if (cur[0] && count < 8) wcscpy(names[count++], cur);
			n = 0;
			if (!*c) break;
			c += skip - 1;
		} else if (n + 1 < 128) {
			cur[n++] = *c;
		}
	}
	if (!count) {
		wcsncpy(names[0], artist, 127);
		names[0][127] = L'\0';
		count = 1;
	}
	return count;
}

/* Does `candidate` (an artist as a source writes it) share a name with `artist`? */
static BOOL artist_matches(const wchar_t *artist, const wchar_t *candidate) {
	wchar_t names[8][128];
	int count = split_artists(artist, names);
	wchar_t *ca = norm(candidate);
	BOOL match = FALSE;
	if (!ca) return FALSE;
	for (int i = 0; i <= count && ca[0] && !match; i++) {
		wchar_t *n = norm(i < count ? names[i] : artist);
		if (n && n[0]) match = wcsstr(ca, n) || wcsstr(n, ca);
		free(n);
	}
	free(ca);
	return match;
}

/* ---------------------------------------------------------------- lyrics */

typedef struct {
	int off; /* ms from the line's first word */
	wchar_t *text;
} Word;

typedef struct {
	int t; /* ms from the start of the song */
	wchar_t *text;
	wchar_t *norm;
	Word *words; /* NULL when the source has no time per word */
	int nwords;
} Line;

/* Shared by every copy of a variant, freed with the last one. */
typedef struct {
	LONG refs;
	Line *lines;
	int n;
	BOOL words;
} Lyrics;

static Lyrics *lyrics_new(void) {
	Lyrics *ly = (Lyrics *)calloc(1, sizeof(Lyrics));
	if (ly) ly->refs = 1;
	return ly;
}

static Lyrics *lyrics_ref(Lyrics *ly) {
	if (ly) InterlockedIncrement(&ly->refs);
	return ly;
}

static void lyrics_unref(Lyrics *ly) {
	if (!ly || InterlockedDecrement(&ly->refs) > 0) return;
	for (int i = 0; i < ly->n; i++) {
		for (int w = 0; w < ly->lines[i].nwords; w++) free(ly->lines[i].words[w].text);
		free(ly->lines[i].words);
		free(ly->lines[i].text);
		free(ly->lines[i].norm);
	}
	free(ly->lines);
	free(ly);
}

/* Takes ownership of `text` and `words`. */
static void lyrics_add(Lyrics *ly, int t, wchar_t *text, Word *words, int nwords) {
	if (ly->n % 32 == 0) {
		Line *grown = (Line *)realloc(ly->lines, (size_t)(ly->n + 32) * sizeof(Line));
		if (!grown) {
			free(text);
			for (int w = 0; w < nwords; w++) free(words[w].text);
			free(words);
			return;
		}
		ly->lines = grown;
	}
	ly->lines[ly->n].t = t;
	ly->lines[ly->n].text = text ? text : wdup(L"");
	ly->lines[ly->n].norm = norm(ly->lines[ly->n].text);
	ly->lines[ly->n].words = nwords ? words : NULL;
	ly->lines[ly->n].nwords = nwords;
	if (!nwords) free(words);
	if (nwords) ly->words = TRUE;
	ly->n++;
}

static int line_order(const void *a, const void *b) {
	const Line *x = (const Line *)a, *y = (const Line *)b;
	return x->t < y->t ? -1 : x->t > y->t;
}

/* "[mm:ss.xx]" or "<mm:ss.xx>" at `s` -> ms, and where it ends; -1 if it is not one. */
static int time_tag(const wchar_t *s, wchar_t open, const wchar_t **end) {
	wchar_t close = open == L'[' ? L']' : L'>';
	const wchar_t *c = s + 1;
	long minutes = 0, seconds = 0, part = 0, scale = 1;
	if (*s != open || !iswdigit(*c)) return -1;
	while (iswdigit(*c)) minutes = minutes * 10 + (*c++ - L'0');
	if (*c++ != L':' || !iswdigit(*c)) return -1;
	while (iswdigit(*c)) seconds = seconds * 10 + (*c++ - L'0');
	if (*c == L'.' || *c == L':') {
		c++;
		if (!iswdigit(*c)) return -1;
		while (iswdigit(*c)) {
			if (scale < 1000) {
				part = part * 10 + (*c - L'0');
				scale *= 10;
			}
			c++;
		}
	}
	if (*c != close) return -1;
	*end = c + 1;
	return (int)((minutes * 60 + seconds) * 1000 + part * 1000 / scale);
}

/* "<mm:ss.xx>word word<mm:ss.xx>word" -> words, each with the last time before
 * it, and the plain text in `plain`. 0 words when there are no word tags. */
static int split_words(const wchar_t *rest, Word **out, wchar_t *plain) {
	Word *words = (Word *)calloc(wcslen(rest) + 1, sizeof(Word));
	int nwords = 0, cur = -1;
	size_t p = 0;
	*out = NULL;
	plain[0] = L'\0';
	for (const wchar_t *c = rest; words && *c;) {
		const wchar_t *end, *start;
		int t = *c == L'<' ? time_tag(c, L'<', &end) : -1;
		if (t >= 0) {
			cur = t;
			c = end;
			continue;
		}
		if (is_space(*c)) {
			c++;
			continue;
		}
		start = c;
		while (*c && !is_space(*c) && !(*c == L'<' && time_tag(c, L'<', &end) >= 0)) c++;
		if (cur < 0) continue;
		words[nwords].off = cur;
		words[nwords].text = wdupn(start, (size_t)(c - start));
		if (p) plain[p++] = L' ';
		memcpy(plain + p, start, (size_t)(c - start) * sizeof(wchar_t));
		p += (size_t)(c - start);
		nwords++;
	}
	plain[p] = L'\0';
	if (!nwords) free(words);
	else *out = words;
	return nwords;
}

/* LRC text -> lines in time order (NULL when there are none). A line with two tags is sung twice. */
static Lyrics *parse_lrc(const wchar_t *text) {
	Lyrics *ly = lyrics_new();
	const wchar_t *line = text;
	if (!ly) return NULL;
	while (line && *line) {
		const wchar_t *eol = wcschr(line, L'\n');
		size_t len = eol ? (size_t)(eol - line) : wcslen(line), n = 0;
		wchar_t *rest = (wchar_t *)malloc((len + 1) * sizeof(wchar_t));
		int times[16], ntimes = 0;
		if (!rest) break;
		/* every [mm:ss] tag, wherever it is; the rest is the text */
		for (const wchar_t *c = line; c < line + len;) {
			const wchar_t *end;
			int t = *c == L'[' ? time_tag(c, L'[', &end) : -1;
			if (t >= 0 && end <= line + len) {
				if (ntimes < 16) times[ntimes++] = t;
				c = end;
			} else {
				rest[n++] = *c++;
			}
		}
		rest[n] = L'\0';
		line = eol ? eol + 1 : NULL;
		squeeze(rest);
		if (ntimes) {
			Word *words = NULL;
			wchar_t *plain = (wchar_t *)malloc((wcslen(rest) + 1) * sizeof(wchar_t));
			int nwords = plain && wcschr(rest, L'<') ? split_words(rest, &words, plain) : 0;
			for (int i = 0; i < ntimes; i++) {
				Word *copy = nwords ? (Word *)calloc((size_t)nwords, sizeof(Word)) : NULL;
				for (int w = 0; copy && w < nwords; w++) {
					copy[w].off = words[w].off - words[0].off;
					copy[w].text = wdup(words[w].text);
				}
				lyrics_add(ly, times[i], wdup(nwords ? plain : rest), copy, copy ? nwords : 0);
			}
			for (int w = 0; w < nwords; w++) free(words[w].text);
			free(words);
			free(plain);
		}
		free(rest);
	}
	if (ly->n > 1) qsort(ly->lines, (size_t)ly->n, sizeof(Line), line_order);
	if (!ly->n) {
		lyrics_unref(ly);
		return NULL;
	}
	return ly;
}

/*
 * How long each line is really sung. Between two lines there may be a pause,
 * so the gap is only an upper limit: the singing speed (letters per second) is
 * taken from the lines sung fast (70th percentile of all lines), and a line
 * takes as long as its letters need at that speed.
 */
static int *sing_times(const Lyrics *ly) {
	int count = ly ? ly->n : 0, nrates = 0;
	int *out = (int *)calloc((size_t)count + 1, sizeof(int));
	double *rates = (double *)calloc((size_t)count + 1, sizeof(double)), rate = 12.0;
	if (!out || !rates) {
		free(rates);
		return out;
	}
	for (int i = 0; i < count; i++) {
		int gap = i + 1 < count ? ly->lines[i + 1].t - ly->lines[i].t : 4000, ch = word_chars(ly->lines[i].text);
		if (ch >= 6 && gap >= 1200 && gap <= 12000) rates[nrates++] = ch / (gap / 1000.0);
	}
	for (int i = 1; i < nrates; i++) /* a few dozen values: insertion sort */
		for (int j = i; j > 0 && rates[j - 1] > rates[j]; j--) {
			double tmp = rates[j];
			rates[j] = rates[j - 1];
			rates[j - 1] = tmp;
		}
	if (nrates) rate = rates[(int)(nrates * 0.7)];
	rate = rate < 6 ? 6 : rate > 30 ? 30 : rate;
	for (int i = 0; i < count; i++) {
		int gap = i + 1 < count ? ly->lines[i + 1].t - ly->lines[i].t : 4000;
		double want = word_chars(ly->lines[i].text) / rate * 1000 + 250;
		if (want > gap - 80) want = gap - 80;
		out[i] = (int)(want < 700 ? 700 : want);
	}
	free(rates);
	return out;
}

/* ------------------------------------------------------------- variants */

/* One timing of a song's lyrics. Equal timings get the same id, wherever they come from. */
typedef struct {
	char id[17];
	wchar_t sources[64]; /* "lrclib+netease" */
	int votes; /* copies found */
	int support; /* copies that agree with it, its own included */
	Lyrics *ly;
} Variant;

typedef struct {
	Variant *items;
	int n;
} Variants;

static void variant_id(const Lyrics *ly, char *out) {
	unsigned long long h = 0xcbf29ce484222325ULL;
	for (int i = 0; i < ly->n; i++) {
		unsigned t = (unsigned)ly->lines[i].t;
		for (int b = 0; b < 4; b++) h = (h ^ ((t >> (8 * b)) & 0xFF)) * 0x100000001b3ULL;
		for (const wchar_t *c = ly->lines[i].norm; c && *c; c++) h = (h ^ (unsigned)*c) * 0x100000001b3ULL;
		h = (h ^ (ly->lines[i].words ? 1u : 2u)) * 0x100000001b3ULL;
	}
	snprintf(out, 17, "%016llx", h);
}

static void variants_free(Variants *vs) {
	for (int i = 0; i < vs->n; i++) lyrics_unref(vs->items[i].ly);
	free(vs->items);
	vs->items = NULL;
	vs->n = 0;
}

/* A copy that shares the lyrics. */
static Variants variants_copy(const Variants *vs) {
	Variants out = { NULL, 0 };
	if (vs->n && (out.items = (Variant *)malloc((size_t)vs->n * sizeof(Variant))) != NULL) {
		memcpy(out.items, vs->items, (size_t)vs->n * sizeof(Variant));
		out.n = vs->n;
		for (int i = 0; i < out.n; i++) lyrics_ref(out.items[i].ly);
	}
	return out;
}

static void add_source(Variant *v, const wchar_t *source) {
	wchar_t names[64], *ctx = NULL;
	wcscpy(names, source);
	for (wchar_t *name = wcstok(names, L"+", &ctx); name; name = wcstok(NULL, L"+", &ctx)) {
		if (wcsstr(v->sources, name) || wcslen(v->sources) + wcslen(name) + 2 > 63) continue;
		if (v->sources[0]) wcscat(v->sources, L"+");
		wcscat(v->sources, name);
	}
}

/*
 * Adds a variant (taking its lyrics). The same timing found again — LRCLIB
 * keeps many copies of a song, sources share data — only adds votes.
 */
static void variants_add(Variants *vs, const wchar_t *source, Lyrics *ly, int votes) {
	char id[17];
	Variant *grown;
	if (!ly) return;
	variant_id(ly, id);
	for (int i = 0; i < vs->n; i++) {
		if (strcmp(vs->items[i].id, id)) continue;
		vs->items[i].votes += votes;
		add_source(&vs->items[i], source);
		lyrics_unref(ly);
		return;
	}
	grown = (Variant *)realloc(vs->items, (size_t)(vs->n + 1) * sizeof(Variant));
	if (!grown) {
		lyrics_unref(ly);
		return;
	}
	vs->items = grown;
	ZeroMemory(&vs->items[vs->n], sizeof(Variant));
	strcpy(vs->items[vs->n].id, id);
	add_source(&vs->items[vs->n], source);
	vs->items[vs->n].votes = votes;
	vs->items[vs->n].ly = ly;
	vs->n++;
}

/* Moves every variant of `from` into `into`. */
static void variants_merge(Variants *into, Variants *from) {
	for (int i = 0; i < from->n; i++) variants_add(into, from->items[i].sources, from->items[i].ly, from->items[i].votes);
	free(from->items);
	from->items = NULL;
	from->n = 0;
}

/*
 * How much later `b` sings the same lines than `a` (median, ms). FALSE when
 * they share too few lines to tell.
 */
static BOOL line_shift(const Lyrics *a, const Lyrics *b, int *shift) {
	int *d = (int *)malloc(((size_t)a->n + 1) * sizeof(int)), nd = 0;
	BOOL ok;
	if (!d) return FALSE;
	for (int i = 0; i < a->n; i++) {
		int k = 0, seen = 0;
		const wchar_t *key = a->lines[i].norm;
		if (!key || !key[0]) continue;
		/* the k-th time this line comes in a pairs with its k-th time in b */
		for (int j = 0; j < i; j++) k += a->lines[j].norm && !wcscmp(a->lines[j].norm, key);
		for (int j = 0; j < b->n; j++) {
			if (!b->lines[j].norm || wcscmp(b->lines[j].norm, key)) continue;
			if (seen++ == k) {
				d[nd++] = b->lines[j].t - a->lines[i].t;
				break;
			}
		}
	}
	ok = nd >= 3 && nd >= (a->n < b->n ? a->n : b->n) * 0.4;
	if (ok) {
		for (int i = 1; i < nd; i++)
			for (int j = i; j > 0 && d[j - 1] > d[j]; j--) {
				int tmp = d[j];
				d[j] = d[j - 1];
				d[j - 1] = tmp;
			}
		*shift = d[nd / 2];
	}
	free(d);
	return ok;
}

/* The place of a source in the order of preference. */
static int source_rank(const wchar_t *sources) {
	static const wchar_t *order[] = { L"musixmatch", L"lrclib", L"netease" };
	for (int i = 0; i < 3; i++)
		if (wcsstr(sources, order[i])) return i;
	return 9;
}

static BOOL variant_better(const Variant *a, const Variant *b, int total) {
	BOOL aOut = a->support * 2 <= total, bOut = b->support * 2 <= total;
	if (a->ly->words != b->ly->words) return a->ly->words;
	if (aOut != bOut) return !aOut;
	if (source_rank(a->sources) != source_rank(b->sources)) return source_rank(a->sources) < source_rank(b->sources);
	return a->votes > b->votes;
}

/*
 * Best first: word timing; then timings that agree (lines within 0.35 s) with
 * most of the copies found — an outlier is usually another version of the
 * song, seconds off; then the order of the sources; then the number of copies.
 * Without the audio nothing knows the true timing; one that independent
 * uploads share is rarely the wrong one.
 */
static void rank_variants(Variants *vs) {
	int total = 0;
	for (int i = 0; i < vs->n; i++) total += vs->items[i].votes;
	for (int i = 0; i < vs->n; i++) {
		vs->items[i].support = 0;
		for (int j = 0; j < vs->n; j++) {
			int s;
			if (i == j || (line_shift(vs->items[i].ly, vs->items[j].ly, &s) && abs(s) <= 350))
				vs->items[i].support += vs->items[j].votes;
		}
	}
	for (int i = 1; i < vs->n; i++)
		for (int j = i; j > 0 && variant_better(&vs->items[j], &vs->items[j - 1], total); j--) {
			Variant tmp = vs->items[j];
			vs->items[j] = vs->items[j - 1];
			vs->items[j - 1] = tmp;
		}
}

/* ------------------------------------------------------------- the track */

typedef struct {
	wchar_t artist[256];
	wchar_t title[256];
	double durationS;
	wchar_t first[128]; /* the first of the artists */
	wchar_t clean[256]; /* the title as a search term */
	BOOL russian; /* the title is in Cyrillic: the lyrics should be too */
} Track;

static int count_letters(const wchar_t *s, int *latin) {
	int cyr = 0;
	*latin = 0;
	for (; s && *s; s++) {
		if ((*s >= 0x0410 && *s <= 0x044F) || *s == 0x0401 || *s == 0x0451) cyr++;
		else if ((*s >= L'A' && *s <= L'Z') || (*s >= L'a' && *s <= L'z')) (*latin)++;
	}
	return cyr;
}

static void track_init(Track *t, const wchar_t *artist, const wchar_t *title, double durationS) {
	wchar_t names[8][128];
	int latin;
	ZeroMemory(t, sizeof(*t));
	wcsncpy(t->artist, artist, 255);
	wcsncpy(t->title, title, 255);
	t->durationS = durationS;
	split_artists(artist, names);
	wcscpy(t->first, names[0]);
	clean_title(title, t->clean, 256);
	t->russian = count_letters(title, &latin) + count_letters(artist, &latin) > 0;
}

/*
 * Why a result cannot be right (NULL = it looks fine): the wrong script (a
 * transliteration, a translation or a placeholder), far more lines than a
 * song has, or times past the end of the track.
 */
static const wchar_t *check_lyrics(const Lyrics *ly, const Track *t, wchar_t *why, size_t len) {
	int cyr = 0, latin = 0, tot;
	for (int i = 0; i < ly->n; i++) {
		int l;
		cyr += count_letters(ly->lines[i].text, &l);
		latin += l;
	}
	tot = cyr + latin;
	/* Songs mix languages (Russian verses with English hooks are 30-40%
	 * Cyrillic); only text with next to no Cyrillic is not the original. */
	if (tot && t->russian && cyr * 10 < tot) {
		_snwprintf(why, len, L"expected Russian text, got %d%% Cyrillic", 100 * cyr / tot);
		return why;
	}
	if (t->durationS > 0) {
		double most = t->durationS / 1.3;
		if (ly->n > (most > 12 ? most : 12)) {
			_snwprintf(why, len, L"%d lines in a %d s track", ly->n, (int)t->durationS);
			return why;
		}
		if (ly->lines[ly->n - 1].t > (t->durationS + 20) * 1000) {
			_snwprintf(why, len, L"timestamps run past the end of the track");
			return why;
		}
	}
	return NULL;
}

/* -------------------------------------------------------------- sources */

/* Where a source writes what it has to say (the program's journal). */
static void (*lyrics_log)(const wchar_t *format, ...);

/* A candidate a source offers: its artist and length, and where its lyrics are. */
typedef struct {
	const wchar_t *artist;
	double durationS; /* 0 = unknown */
	const JVal *item;
	int artistMiss; /* 0 = shares an artist name */
	double off; /* seconds from the track's length */
} Candidate;

static int candidate_order(const void *a, const void *b) {
	const Candidate *x = (const Candidate *)a, *y = (const Candidate *)b;
	if (x->artistMiss != y->artistMiss) return x->artistMiss - y->artistMiss;
	return x->off < y->off ? -1 : x->off > y->off;
}

/*
 * The candidates that are this recording, closest in length first: all that
 * share an artist name and are at most 6 s apart; when none shares the artist
 * (a transliterated name) only the closest one. Returns how many are kept, at
 * the front of `c`.
 */
static int keep_matching(Candidate *c, int n, const Track *t) {
	int kept = 0;
	for (int i = 0; i < n; i++) {
		c[i].artistMiss = !artist_matches(t->artist, c[i].artist);
		c[i].off = t->durationS > 0 && c[i].durationS > 0 ? fabs(c[i].durationS - t->durationS) : 5;
	}
	if (n > 1) qsort(c, (size_t)n, sizeof(Candidate), candidate_order);
	if (!n || c[0].off > 6) return 0; /* more than 6 s apart = a different recording */
	if (c[0].artistMiss) return 1;
	for (int i = 0; i < n; i++)
		if (!c[i].artistMiss && c[i].off <= 6) c[kept++] = c[i];
	return kept;
}

static void duration_param(wchar_t *url, const Track *t) {
	wchar_t d[16];
	if (t->durationS <= 0) return;
	_snwprintf(d, 16, L"%d", (int)(t->durationS + 0.5));
	url_param(url, 2048, L"duration", d);
}

/* Every source returns 1 when it answered (whatever it found), 0 when it did not. */

static int source_lrclib(const Track *t, Variants *out) {
	Fetch f[8];
	JVal *docs[8] = { 0 };
	Candidate c[256];
	int n = 0, kept, answered = 0;
	wchar_t q[400];
	ZeroMemory(f, sizeof(f));
	/* stage 1: LRCLIB's own database (get-cached answers at once) and its searches */
	for (int i = 0; i < 6; i++) {
		f[i].timeoutMs = 5000;
		wcscpy(f[i].url, i < 3 ? L"https://lrclib.net/api/get-cached" : L"https://lrclib.net/api/search");
	}
	url_param(f[0].url, 2048, L"artist_name", t->artist);
	url_param(f[0].url, 2048, L"track_name", t->title);
	duration_param(f[0].url, t);
	url_param(f[1].url, 2048, L"artist_name", t->first);
	url_param(f[1].url, 2048, L"track_name", t->title);
	duration_param(f[1].url, t);
	url_param(f[2].url, 2048, L"artist_name", t->first);
	url_param(f[2].url, 2048, L"track_name", t->clean);
	url_param(f[3].url, 2048, L"track_name", t->title);
	url_param(f[3].url, 2048, L"artist_name", t->first);
	_snwprintf(q, 400, L"%ls %ls", t->first, t->clean);
	q[399] = L'\0';
	url_param(f[4].url, 2048, L"q", q);
	url_param(f[5].url, 2048, L"q", t->clean);
	fetch_all(f, 6);
	for (int i = 3; i < 6; i++) answered += f[i].status != 0; /* a search never says 404 */
	for (int pass = 0; pass < 2; pass++) {
		int from = pass ? 6 : 0, to = pass ? 8 : 6;
		if (pass) {
			/* stage 2: the slow /get that may ask other providers */
			if (n || !answered) break;
			for (int i = 6; i < 8; i++) {
				f[i].timeoutMs = 6000;
				wcscpy(f[i].url, L"https://lrclib.net/api/get");
				url_param(f[i].url, 2048, L"artist_name", i == 6 ? t->artist : t->first);
				url_param(f[i].url, 2048, L"track_name", i == 6 ? t->title : t->clean);
				duration_param(f[i].url, t);
			}
			fetch_all(f + 6, 2);
		}
		for (int i = from; i < to; i++) {
			const JVal *doc;
			if (!f[i].body || !(docs[i] = json_parse(f[i].body))) continue;
			doc = docs[i];
			/* /get answers with one entry, /search with a list */
			for (const JVal *item = doc->type == J_ARR ? doc->child : doc; item; item = doc->type == J_ARR ? item->next : NULL) {
				double id = json_num(item, L"id", -1);
				BOOL seen = FALSE;
				if (!*json_str(item, L"syncedLyrics")) continue;
				for (int k = 0; k < n && !seen; k++) seen = json_num(c[k].item, L"id", -2) == id;
				if (seen || n >= 256) continue;
				c[n].artist = json_str(item, L"artistName");
				c[n].durationS = json_num(item, L"duration", 0);
				c[n].item = item;
				n++;
			}
		}
	}
	kept = keep_matching(c, n, t);
	for (int i = 0; i < kept; i++) variants_add(out, L"lrclib", parse_lrc(json_str(c[i].item, L"syncedLyrics")), 1);
	for (int i = 0; i < 8; i++) {
		json_free(docs[i]);
		free(f[i].body);
	}
	return n || answered;
}

/* A credits line NetEase puts among the lyrics ("作词 : X"). */
static BOOL netease_credit(const wchar_t *line) {
	static const wchar_t *words[] = { L"\x4f5c\x8bcd", L"\x4f5c\x66f2", L"\x7f16\x66f2", L"\x5236\x4f5c", L"\x6df7\x97f3",
		L"\x6bcd\x5e26", L"Lyrics", L"Music", L"Composer", L"Producer", L"Arranger" };
	const wchar_t *c = line, *end;
	while (*c == L'[' && time_tag(c, L'[', &end) >= 0) c = end;
	while (is_space(*c)) c++;
	for (size_t i = 0; i < sizeof(words) / sizeof(words[0]); i++) {
		if (!starts_with_ci(c, words[i])) continue;
		c += wcslen(words[i]);
		while (is_space(*c)) c++;
		return *c == L':' || *c == 0xFF1A;
	}
	return FALSE;
}

static int source_netease(const Track *t, Variants *out) {
	Fetch f[2], lyr[3];
	JVal *docs[2] = { 0 };
	Candidate c[32];
	int n = 0, kept;
	ZeroMemory(f, sizeof(f));
	ZeroMemory(lyr, sizeof(lyr));
	for (int i = 0; i < 2; i++) {
		wchar_t q[400];
		if (i == 0) _snwprintf(q, 400, L"%ls %ls", t->first, t->clean);
		else wcscpy(q, t->clean);
		q[399] = L'\0';
		f[i].timeoutMs = 6000;
		wcscpy(f[i].url, L"https://music.163.com/api/search/get");
		url_param(f[i].url, 2048, L"s", q);
		wcscat(f[i].url, L"&type=1&limit=8");
	}
	fetch_all(f, 2);
	if (!f[0].status && !f[1].status) return 0;
	for (int i = 0; i < 2; i++) {
		const JVal *songs;
		docs[i] = json_parse(f[i].body);
		songs = json_get(json_get(docs[i], L"result"), L"songs");
		for (const JVal *song = songs ? songs->child : NULL; song && n < 32; song = song->next) {
			double id = json_num(song, L"id", -1);
			const JVal *artists = json_get(song, L"artists");
			BOOL seen = FALSE;
			for (int k = 0; k < n && !seen; k++) seen = json_num(c[k].item, L"id", -2) == id;
			if (seen) continue;
			/* the first artist stands for all of them, which is enough to match one */
			c[n].artist = artists && artists->child ? json_str(artists->child, L"name") : L"";
			c[n].durationS = json_num(song, L"duration", 0) / 1000.0;
			c[n].item = song;
			n++;
		}
	}
	kept = keep_matching(c, n, t);
	if (kept > 3) kept = 3;
	for (int i = 0; i < kept; i++) {
		lyr[i].timeoutMs = 6000;
		_snwprintf(lyr[i].url, 2048, L"https://music.163.com/api/song/lyric?id=%.0f&lv=1&kv=1&tv=-1", json_num(c[i].item, L"id", 0));
	}
	fetch_all(lyr, kept);
	for (int i = 0; i < kept; i++) {
		JVal *doc = json_parse(lyr[i].body);
		const wchar_t *text = json_str(json_get(doc, L"lrc"), L"lyric"), *line = text;
		wchar_t *lines = (wchar_t *)calloc(wcslen(text) + 2, sizeof(wchar_t));
		size_t used = 0;
		while (lines && line && *line) {
			const wchar_t *eol = wcschr(line, L'\n');
			size_t len = eol ? (size_t)(eol - line) + 1 : wcslen(line);
			wchar_t *one = wdupn(line, len);
			if (one && !netease_credit(one)) {
				memcpy(lines + used, one, len * sizeof(wchar_t));
				used += len;
			}
			free(one);
			line = eol ? eol + 1 : NULL;
		}
		if (lines) variants_add(out, L"netease", parse_lrc(lines), 1);
		free(lines);
		json_free(doc);
		free(lyr[i].body);
	}
	for (int i = 0; i < 2; i++) {
		json_free(docs[i]);
		free(f[i].body);
	}
	return 1;
}

/* Musixmatch's word timing: [{"ts":1.5,"l":[{"c":"Word","o":0.0},{"c":" ","o":0.4},...],"x":"Word ..."}]. */
static Lyrics *mxm_richsync(const wchar_t *body) {
	char *utf8 = utf8_of(body);
	JVal *doc = json_parse(utf8);
	Lyrics *ly = doc && doc->type == J_ARR ? lyrics_new() : NULL;
	free(utf8);
	for (const JVal *line = ly ? doc->child : NULL; line; line = line->next) {
		const JVal *chars = json_get(line, L"l");
		Word *words = (Word *)calloc(256, sizeof(Word));
		int nwords = 0, start = -1;
		wchar_t cur[256], text[2048], *x = wdup(json_str(line, L"x"));
		size_t used = 0;
		text[0] = L'\0';
		for (const JVal *ch = chars ? chars->child : NULL; words && ch; ch = ch->next) {
			const wchar_t *piece = json_str(ch, L"c");
			int o = (int)(json_num(ch, L"o", 0) * 1000);
			BOOL blank = TRUE;
			for (const wchar_t *p = piece; *p; p++) blank = blank && is_space(*p);
			if (!blank) {
				if (start < 0) start = o;
				for (const wchar_t *p = piece; *p && used + 1 < 256; p++) cur[used++] = *p;
			}
			if ((blank || !ch->next) && used && nwords < 256) {
				cur[used] = L'\0';
				words[nwords].off = start;
				words[nwords++].text = wdup(cur);
				used = 0;
				start = -1;
			}
		}
		for (int w = 0; w < nwords; w++) {
			if (w) wcsncat(text, L" ", 2047 - wcslen(text));
			wcsncat(text, words[w].text, 2047 - wcslen(text));
		}
		if (x) squeeze(x);
		/* The words count only when they spell the line's text. */
		if (!nwords || !x || wcscmp(x, text)) {
			for (int w = 0; w < nwords; w++) free(words[w].text);
			nwords = 0;
			if (x) wcsncpy(text, x, 2047);
			text[2047] = L'\0';
		} else {
			for (int w = nwords - 1; w >= 0; w--) words[w].off -= words[0].off;
		}
		free(x);
		lyrics_add(ly, (int)(json_num(line, L"ts", 0) * 1000), wdup(text), words, nwords);
	}
	json_free(doc);
	if (ly && !ly->n) {
		lyrics_unref(ly);
		ly = NULL;
	}
	return ly;
}

/* Musixmatch's line timing: [{"text":"...","time":{"total":1.5}}], or LRC. */
static Lyrics *mxm_subtitle(const wchar_t *body) {
	char *utf8 = utf8_of(body);
	JVal *doc = json_parse(utf8);
	Lyrics *ly = NULL;
	free(utf8);
	if (doc && doc->type == J_ARR && (ly = lyrics_new()) != NULL) {
		for (const JVal *item = doc->child; item; item = item->next)
			lyrics_add(ly, (int)(json_num(json_get(item, L"time"), L"total", 0) * 1000), wdup(json_str(item, L"text")), NULL, 0);
		if (!ly->n) {
			lyrics_unref(ly);
			ly = NULL;
		}
	} else if (!doc) {
		ly = parse_lrc(body);
	}
	json_free(doc);
	return ly;
}

static const JVal *mxm_body(const JVal *calls, const wchar_t *call) {
	return json_get(json_get(json_get(calls, call), L"message"), L"body");
}

static wchar_t g_mxmGuid[40];

/* Musixmatch, with the token of the user's own account (it hands out no
 * anonymous ones any more). */
static int source_musixmatch(const Track *t, const wchar_t *token, Variants *out) {
	wchar_t url[2048], headers[200], d[16];
	DWORD status = 0;
	char *body;
	JVal *doc;
	const JVal *calls, *track, *subs;
	Lyrics *ly = NULL;
	int length;

	if (!g_mxmGuid[0]) {
		LARGE_INTEGER seed;
		QueryPerformanceCounter(&seed);
		_snwprintf(g_mxmGuid, 40, L"%08lx%08lx", (unsigned long)(seed.QuadPart * 2654435761u), (unsigned long)GetTickCount() * 40503u);
	}
	_snwprintf(headers, 200, L"Cookie: x-mxm-token-guid=%ls\r\nAuthority: apic-desktop.musixmatch.com\r\n", g_mxmGuid);
	_snwprintf(d, 16, L"%d", (int)(t->durationS + 0.5));
	wcscpy(url, L"https://apic-desktop.musixmatch.com/ws/1.1/macro.subtitles.get?format=json&namespace=lyrics_richsynched"
				L"&subtitle_format=mxm&app_id=web-desktop-app-v1.0");
	url_param(url, 2048, L"usertoken", token);
	url_param(url, 2048, L"q_artist", t->first);
	url_param(url, 2048, L"q_track", t->clean);
	if (t->durationS > 0) {
		url_param(url, 2048, L"q_duration", d);
		url_param(url, 2048, L"f_subtitle_length", d);
	}
	url_param(url, 2048, L"guid", g_mxmGuid);
	body = http_get(url, headers, 6000, &status);
	if (!body) return 0;
	doc = json_parse(body);
	free(body);
	calls = json_get(json_get(json_get(doc, L"message"), L"body"), L"macro_calls");
	if (!calls) {
		double code = json_num(json_get(json_get(doc, L"message"), L"header"), L"status_code", 0);
		if (lyrics_log)
			lyrics_log(L"  musixmatch: no answer to the search (status %.0f%ls)", code, code == 401 ? L", the token is not accepted" : L"");
		json_free(doc);
		return 1;
	}
	track = json_get(mxm_body(calls, L"matcher.track.get"), L"track");
	length = (int)json_num(track, L"track_length", 0);
	{
		/* What it matched: the right artist, or at least the right title; the right length. */
		const wchar_t *artist = json_str(track, L"artist_name"), *name = json_str(track, L"track_name");
		wchar_t *a = norm(t->clean), *b = norm(name);
		BOOL titleOk = a && b && b[0] && (wcsstr(a, b) || wcsstr(b, a));
		free(a);
		free(b);
		if (!track || (artist[0] && !artist_matches(t->artist, artist) && !titleOk)) {
			if (lyrics_log) lyrics_log(L"  musixmatch rejected: matched another song: %ls - %ls", artist, name);
			json_free(doc);
			return 1;
		}
		if (t->durationS > 0 && length > 0 && fabs(length - t->durationS) > 10) {
			if (lyrics_log) lyrics_log(L"  musixmatch rejected: a track of another length (%d s vs %d s)", length, (int)t->durationS);
			json_free(doc);
			return 1;
		}
	}
	if (json_num(track, L"has_richsync", 0) && json_num(track, L"commontrack_id", 0) > 0) {
		/* the word timing has a call of its own */
		int n = length ? length : (int)(t->durationS + 0.5);
		_snwprintf(url, 2048,
			L"https://apic-desktop.musixmatch.com/ws/1.1/track.richsync.get?format=json&subtitle_format=mxm"
			L"&app_id=web-desktop-app-v1.0&commontrack_id=%.0f&f_subtitle_length=%d&q_duration=%d",
			json_num(track, L"commontrack_id", 0), n, n);
		url_param(url, 2048, L"usertoken", token);
		url_param(url, 2048, L"guid", g_mxmGuid);
		body = http_get(url, headers, 6000, &status);
		if (body) {
			JVal *rich = json_parse(body);
			const wchar_t *text = json_str(json_get(json_get(json_get(rich, L"message"), L"body"), L"richsync"), L"richsync_body");
			if (text[0]) ly = mxm_richsync(text);
			json_free(rich);
			free(body);
		}
	}
	subs = json_get(mxm_body(calls, L"track.subtitles.get"), L"subtitle_list");
	if (!ly && subs && subs->child) ly = mxm_subtitle(json_str(json_get(subs->child, L"subtitle"), L"subtitle_body"));
	variants_add(out, L"musixmatch", ly, 1);
	json_free(doc);
	return 1;
}

/* ------------------------------------------------------------------- cache */

/* A growing UTF-8 text, for the cache files and the frames to notGT. */
typedef struct {
	char *s;
	size_t n, cap;
} Text;

static void text_raw(Text *t, const char *s) {
	size_t len = strlen(s);
	if (t->n + len + 1 > t->cap) {
		size_t cap = t->cap ? t->cap * 2 : 4096;
		char *grown;
		while (cap < t->n + len + 1) cap *= 2;
		grown = (char *)realloc(t->s, cap);
		if (!grown) return;
		t->s = grown;
		t->cap = cap;
	}
	memcpy(t->s + t->n, s, len + 1);
	t->n += len;
}

static void text_printf(Text *t, const char *format, ...) {
	char buf[256];
	va_list args;
	va_start(args, format);
	vsnprintf(buf, sizeof(buf), format, args);
	va_end(args);
	text_raw(t, buf);
}

/* A JSON string literal. */
static void text_str(Text *t, const wchar_t *value) {
	char *utf8 = utf8_of(value), one[8];
	text_raw(t, "\"");
	for (const unsigned char *c = (const unsigned char *)(utf8 ? utf8 : ""); *c; c++) {
		if (*c == '"' || *c == '\\') {
			one[0] = '\\';
			one[1] = (char)*c;
			one[2] = '\0';
		} else if (*c < 0x20) {
			snprintf(one, sizeof(one), "\\u%04x", *c);
		} else {
			one[0] = (char)*c;
			one[1] = '\0';
		}
		text_raw(t, one);
	}
	text_raw(t, "\"");
	free(utf8);
}

static void text_lyrics(Text *t, const Lyrics *ly) {
	text_raw(t, "[");
	for (int i = 0; i < ly->n; i++) {
		text_printf(t, "%s[%d,", i ? "," : "", ly->lines[i].t);
		text_str(t, ly->lines[i].text);
		if (ly->lines[i].words) {
			text_raw(t, ",[");
			for (int w = 0; w < ly->lines[i].nwords; w++) {
				text_printf(t, "%s[%d,", w ? "," : "", ly->lines[i].words[w].off);
				text_str(t, ly->lines[i].words[w].text);
				text_raw(t, "]");
			}
			text_raw(t, "]]");
		} else {
			text_raw(t, ",null]");
		}
	}
	text_raw(t, "]");
}

static Lyrics *lyrics_from_json(const JVal *list) {
	Lyrics *ly = list && list->type == J_ARR ? lyrics_new() : NULL;
	for (const JVal *line = ly ? list->child : NULL; line; line = line->next) {
		const JVal *t = line->child, *text = t ? t->next : NULL, *words = text ? text->next : NULL;
		Word *w = NULL;
		int nw = 0;
		if (!t || t->type != J_NUM || !text || text->type != J_STR) continue;
		if (words && words->type == J_ARR) {
			for (const JVal *x = words->child; x; x = x->next) nw++;
			w = nw ? (Word *)calloc((size_t)nw, sizeof(Word)) : NULL;
			nw = 0;
			for (const JVal *x = words ? words->child : NULL; w && x; x = x->next) {
				if (!x->child || !x->child->next || x->child->next->type != J_STR) continue;
				w[nw].off = (int)x->child->num;
				w[nw++].text = wdup(x->child->next->str);
			}
		}
		lyrics_add(ly, (int)t->num, wdup(text->str), w, nw);
	}
	if (ly && !ly->n) {
		lyrics_unref(ly);
		ly = NULL;
	}
	return ly;
}

/* What is remembered of a track: its variants, the one chosen, its own shift. */
typedef struct {
	Variants variants;
	char pick[17];
	BOOL manual;
	int offset;
} Remembered;

static void cache_path(const wchar_t *dir, const Track *t, wchar_t *out, size_t len) {
	unsigned long long h = 0xcbf29ce484222325ULL;
	wchar_t key[600];
	_snwprintf(key, 600, L"%ls|%ls|%d", t->artist, t->title, (int)(t->durationS + 0.5));
	key[599] = L'\0';
	for (const wchar_t *c = key; *c; c++) h = (h ^ (unsigned)*c) * 0x100000001b3ULL;
	_snwprintf(out, len, L"%ls\\%016llx.json", dir, h);
	out[len - 1] = L'\0';
}

static BOOL cache_load(const wchar_t *path, Remembered *r) {
	HANDLE file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, 0, NULL);
	DWORD size, got = 0;
	char *body = NULL, *pick;
	JVal *doc;
	const JVal *list;
	ZeroMemory(r, sizeof(*r));
	if (file == INVALID_HANDLE_VALUE) return FALSE;
	size = GetFileSize(file, NULL);
	if (size != INVALID_FILE_SIZE && size < 32 * 1024 * 1024) body = (char *)malloc(size + 1);
	if (body && ReadFile(file, body, size, &got, NULL)) body[got] = '\0';
	else if (body) body[0] = '\0';
	CloseHandle(file);
	doc = body ? json_parse(body) : NULL;
	free(body);
	list = json_get(doc, L"variants");
	for (const JVal *v = list ? list->child : NULL; v; v = v->next) {
		const wchar_t *sources = json_str(v, L"sources");
		variants_add(&r->variants, sources[0] ? sources : L"cache", lyrics_from_json(json_get(v, L"lyrics")),
			(int)json_num(v, L"votes", 1));
	}
	pick = utf8_of(json_str(doc, L"pick"));
	if (pick) {
		strncpy(r->pick, pick, 16);
		free(pick);
	}
	r->manual = json_bool(doc, L"manual");
	r->offset = (int)json_num(doc, L"offset", 0);
	json_free(doc);
	return r->variants.n > 0;
}

static void cache_save(const wchar_t *path, const Variants *vs, const char *pick, BOOL manual, int offset) {
	Text t = { 0 };
	HANDLE file;
	DWORD wrote;
	if (!vs->n) return;
	text_raw(&t, "{\"variants\":[");
	for (int i = 0; i < vs->n; i++) {
		text_printf(&t, "%s{\"id\":\"%s\",\"sources\":", i ? "," : "", vs->items[i].id);
		text_str(&t, vs->items[i].sources);
		text_printf(&t, ",\"votes\":%d,\"lyrics\":", vs->items[i].votes);
		text_lyrics(&t, vs->items[i].ly);
		text_raw(&t, "}");
	}
	text_printf(&t, "],\"pick\":\"%s\",\"manual\":%s,\"offset\":%d}", pick ? pick : "", manual ? "true" : "false", offset);
	file = t.s ? CreateFileW(path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL) : INVALID_HANDLE_VALUE;
	if (file != INVALID_HANDLE_VALUE) {
		WriteFile(file, t.s, (DWORD)t.n, &wrote, NULL);
		CloseHandle(file);
	}
	free(t.s);
}

#endif
