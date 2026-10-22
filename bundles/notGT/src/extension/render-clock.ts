/**
 * The clock a rendered page runs on, put into the out page before its own
 * scripts (`Page.addScriptToEvaluateOnNewDocument`).
 *
 * Until `freeze()` the page runs on real time: it loads, connects and gets its
 * Replicants as always. From then on time moves only in `step(ms)`:
 *
 *  - setTimeout / setInterval / requestAnimationFrame / performance.now / Date
 *    are virtual, and a step runs what falls due in it, in order;
 *  - the browser's own animation timeline is frozen by the renderer (DevTools
 *    `Animation.setPlaybackRate(0)`), and a step moves every running Web
 *    Animation, CSS animation and CSS transition on by exactly the step, so the
 *    animation keeps its own play, pause and finish;
 *  - a video is paused and seeked to where it would be.
 *
 * A step is cut into parts of at most 1/60 s, so a script that counts
 * animation frames sees a display's pace whatever the frame rate of the file.
 *
 * A code animation's frame is created by the page, after the freeze, from a
 * `srcdoc` that a new-document script does not reach. Its first script
 * (RENDER_CLOCK_PRELUDE) calls `adopt(window)`, so it shares this clock.
 *
 * Plain ES5 in a string: it runs in the page, not in Node.
 */
export const RENDER_CLOCK_SOURCE = String.raw`(function () {
	if (window.__notgtClock) return;
	var VIRTUAL = 1e9; // timer ids at or above this are the clock's own
	var FRAME = 1000 / 60;
	var frozen = false;
	var now = 0;
	var nowAtFreeze = 0;
	var dateAtFreeze = 0;
	var seq = VIRTUAL;
	var timers = new Map();
	var frames = new Map();
	var seen = new WeakSet();
	var videos = new WeakMap();
	var realNow = performance.now.bind(performance);
	var RealDate = window.Date;
	var realSetTimeout = window.setTimeout.bind(window);

	function dateNow() {
		return frozen ? dateAtFreeze + (now - nowAtFreeze) : RealDate.now();
	}

	function fakeDate(Base) {
		function D() {
			if (!new.target) return new Base(dateNow()).toString();
			var args = Array.prototype.slice.call(arguments);
			return Reflect.construct(Base, args.length ? args : [dateNow()], new.target);
		}
		D.prototype = Base.prototype;
		D.now = dateNow;
		D.parse = Base.parse;
		D.UTC = Base.UTC;
		return D;
	}

	function addTimer(fn, ms, args, every) {
		var id = ++seq;
		// A zero delay would spin forever once nothing else moves time.
		var delay = Math.max(1, Number(ms) || 0);
		timers.set(id, { at: now + delay, delay: delay, fn: fn, args: args, every: every });
		return id;
	}

	function install(win) {
		var orig = {
			setTimeout: win.setTimeout,
			setInterval: win.setInterval,
			clearTimeout: win.clearTimeout,
			raf: win.requestAnimationFrame,
			caf: win.cancelAnimationFrame,
			now: win.performance.now.bind(win.performance),
		};
		win.setTimeout = function (fn, ms) {
			if (!frozen) return orig.setTimeout.apply(win, arguments);
			return addTimer(fn, ms, Array.prototype.slice.call(arguments, 2), false);
		};
		win.setInterval = function (fn, ms) {
			if (!frozen) return orig.setInterval.apply(win, arguments);
			return addTimer(fn, ms, Array.prototype.slice.call(arguments, 2), true);
		};
		win.clearTimeout = win.clearInterval = function (id) {
			if (typeof id === "number" && id >= VIRTUAL) timers.delete(id);
			else orig.clearTimeout.call(win, id);
		};
		win.requestAnimationFrame = function (fn) {
			if (!frozen) return orig.raf.call(win, fn);
			var id = ++seq;
			frames.set(id, fn);
			return id;
		};
		win.cancelAnimationFrame = function (id) {
			if (typeof id === "number" && id >= VIRTUAL) frames.delete(id);
			else orig.caf.call(win, id);
		};
		win.performance.now = function () {
			return frozen ? now : orig.now();
		};
		win.Date = fakeDate(win.Date);

		// A video plays on the clock: play() and pause() only say what is wanted.
		var media = win.HTMLMediaElement && win.HTMLMediaElement.prototype;
		if (media) {
			var play = media.play;
			var pause = media.pause;
			media.play = function () {
				this.__notgtWants = true;
				return frozen ? Promise.resolve() : play.call(this);
			};
			media.pause = function () {
				this.__notgtWants = false;
				return pause.call(this);
			};
			media.__notgtPause = pause;
		}
	}

	function documents() {
		var out = [];
		var stack = [document];
		while (stack.length) {
			var doc = stack.pop();
			out.push(doc);
			var inner = doc.querySelectorAll("iframe");
			for (var i = 0; i < inner.length; i++) {
				try {
					if (inner[i].contentDocument) stack.push(inner[i].contentDocument);
				} catch (e) {}
			}
		}
		return out;
	}

	function eachAnimation(fn) {
		var docs = documents();
		for (var i = 0; i < docs.length; i++) {
			var list = docs[i].getAnimations ? docs[i].getAnimations() : [];
			for (var j = 0; j < list.length; j++) fn(list[j]);
		}
	}

	function call(fn, args) {
		if (typeof fn !== "function") return;
		try {
			fn.apply(null, args);
		} catch (e) {
			console.error(e);
		}
	}

	function runTimers(end) {
		for (var guard = 0; guard < 100000; guard++) {
			var nextId = 0;
			var next = null;
			timers.forEach(function (timer, id) {
				if (timer.at <= end && (!next || timer.at < next.at)) {
					next = timer;
					nextId = id;
				}
			});
			if (!next) break;
			now = next.at;
			if (next.every) next.at += next.delay;
			else timers.delete(nextId);
			call(next.fn, next.args);
		}
		now = end;
	}

	function runFrames() {
		var due = Array.from(frames.values());
		frames.clear();
		for (var i = 0; i < due.length; i++) call(due[i], [now]);
	}

	function syncVideo(video) {
		var state = videos.get(video);
		var current = video.currentTime;
		// First seen, or moved by someone else (a restart): count from there.
		if (!state || Math.abs(current - state.set) > 0.05) {
			state = { base: current, at: now, set: current };
			videos.set(video, state);
		}
		if (!video.paused) video.__notgtPause ? video.__notgtPause.call(video) : video.pause();
		var wants = video.__notgtWants === undefined ? video.autoplay : video.__notgtWants;
		if (!wants) {
			state.base = current;
			state.at = now;
			return null;
		}
		var target = state.base + ((now - state.at) / 1000) * (video.playbackRate || 1);
		var length = video.duration;
		if (isFinite(length) && length > 0) target = video.loop ? target % length : Math.min(target, length);
		state.set = target;
		if (Math.abs(target - current) < 1e-4 && video.readyState >= 2) return null;
		return new Promise(function (resolve) {
			var done = function () {
				video.removeEventListener("seeked", done);
				resolve();
			};
			video.addEventListener("seeked", done);
			video.currentTime = target;
		});
	}

	/** Lets the frame be drawn whole: fonts, pictures and video in place. */
	function settle() {
		var waits = [];
		var docs = documents();
		for (var i = 0; i < docs.length; i++) {
			var doc = docs[i];
			if (doc.fonts && doc.fonts.status !== "loaded") waits.push(doc.fonts.ready);
			for (var j = 0; j < doc.images.length; j++) {
				var image = doc.images[j];
				if (!image.complete && image.decode) waits.push(image.decode().catch(function () {}));
			}
			var list = doc.querySelectorAll("video");
			for (var k = 0; k < list.length; k++) {
				var seek = syncVideo(list[k]);
				if (seek) waits.push(seek);
			}
		}
		// A message posted in the step (an animation's hideDone) is delivered too.
		waits.push(wait(0));
		return Promise.race([Promise.all(waits), wait(5000)]);
	}

	function wait(ms) {
		return new Promise(function (resolve) {
			realSetTimeout(resolve, ms);
		});
	}

	install(window);

	window.__notgtClock = {
		adopt: install,
		freeze: function () {
			if (frozen) return;
			nowAtFreeze = realNow();
			now = nowAtFreeze;
			dateAtFreeze = RealDate.now();
			frozen = true;
		},
		step: function (ms) {
			var parts = Math.max(1, Math.ceil(ms / FRAME - 1e-6));
			var dt = ms / parts;
			for (var i = 0; i < parts; i++) {
				eachAnimation(function (animation) {
					if (seen.has(animation) && animation.playState === "running") {
						animation.currentTime = (animation.currentTime || 0) + dt * animation.playbackRate;
					}
				});
				runTimers(now + dt);
				runFrames();
				// What started in this part starts from its beginning in the next.
				eachAnimation(function (animation) {
					seen.add(animation);
				});
			}
			return settle();
		},
		/** Animations there now move from the next step on (made while loading, or by a hide). */
		mark: function () {
			eachAnimation(function (animation) {
				seen.add(animation);
			});
		},
		settle: settle,
		wait: wait,
		get now() {
			return now;
		},
	};
})();`;
