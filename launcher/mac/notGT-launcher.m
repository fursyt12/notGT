/*
 * notGT Launcher for macOS.
 *
 * As on Windows, the window is only a face: everything it does — starting
 * NodeCG, the sign-in, the log — is done by `launcher/index.mjs`, a Node
 * process that this program starts (or finds already running) and talks to
 * on 127.0.0.1. Here the face is that process's own page, the one
 * `notGT.command` opens in a browser, shown in a window of its own.
 *
 * The package is the folder this program sits in:
 *
 *   notGT Launcher.app    this program
 *   node/node             the Node runtime
 *   launcher/index.mjs    what the window shows and drives
 *   app/                  the NodeCG runtime root
 *
 * Closing the window does not stop the server: the Node process stays to look
 * after it, and the next window finds it through the note it keeps in
 * `launcher/launcher-runtime.json`.
 *
 * Build (scripts/build-macos.mjs does this):
 *   clang -fobjc-arc -O2 -mmacosx-version-min=11.0 -arch arm64 -arch x86_64 \
 *     -framework Cocoa -framework WebKit -o notGT-launcher notGT-launcher.m
 *
 * For the build's own check:
 *   --root <dir>       the package folder, instead of the one the app is in
 *   --snapshot <png>   show the page, save a picture of it, stop and exit:
 *                      0 = the page was shown and the picture saved,
 *                      3 = the page was shown, the picture could not be taken,
 *                      anything else = the launcher did not come up
 */
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <dlfcn.h>
#import <sys/xattr.h>

static BOOL gRussian = NO;
/** Set by --snapshot: there is nobody to read an alert. */
static BOOL gUnattended = NO;

/* A text in both languages, side by side — the same convention as the rest of the launcher. */
static NSString *T(NSString *ru, NSString *en) {
	return gRussian ? ru : en;
}

// ----------------------------------------------------------------- the package

/*
 * Where the app really is.
 *
 * macOS runs a downloaded app that still carries the quarantine mark from a
 * read-only copy somewhere else ("translocation"), and next to that copy there
 * is no node/, launcher/ or app/. The system knows where the original is, and
 * that is the folder the package lives in.
 */
static NSString *OriginalBundlePath(void) {
	NSString *path = NSBundle.mainBundle.bundlePath;
	void *security = dlopen("/System/Library/Frameworks/Security.framework/Security", RTLD_LAZY);
	if (!security) return path;
	Boolean (*isTranslocated)(CFURLRef, bool *, CFErrorRef *) =
		(Boolean (*)(CFURLRef, bool *, CFErrorRef *))dlsym(security, "SecTranslocateIsTranslocatedURL");
	CFURLRef (*originalPath)(CFURLRef, CFErrorRef *) =
		(CFURLRef (*)(CFURLRef, CFErrorRef *))dlsym(security, "SecTranslocateCreateOriginalPathForURL");
	if (!isTranslocated || !originalPath) return path;

	NSURL *url = [NSURL fileURLWithPath:path];
	bool translocated = false;
	if (isTranslocated((__bridge CFURLRef)url, &translocated, NULL) && translocated) {
		CFURLRef original = originalPath((__bridge CFURLRef)url, NULL);
		if (original) {
			NSURL *real = CFBridgingRelease(original);
			if (real.path.length > 0) path = real.path;
		}
	}
	return path;
}

static BOOL IsQuarantined(NSString *path) {
	return getxattr(path.fileSystemRepresentation, "com.apple.quarantine", NULL, 0, 0, XATTR_NOFOLLOW) >= 0;
}

/*
 * Takes the quarantine mark off the package.
 *
 * By the time this runs the user has told macOS to open the program. The mark
 * is still on every other file of the unpacked archive, though, and with it
 * the system refuses to load the database driver into Node — the server would
 * not start, with a message about a file nobody has heard of. So the package
 * the user has just agreed to run is cleared as a whole.
 */
static void RemoveQuarantine(NSString *root) {
	NSString *node = [root stringByAppendingPathComponent:@"node/node"];
	if (!IsQuarantined(root) && !IsQuarantined(node)) return;
	NSTask *task = [NSTask new];
	task.executableURL = [NSURL fileURLWithPath:@"/usr/bin/xattr"];
	task.arguments = @[ @"-dr", @"com.apple.quarantine", root ];
	task.standardOutput = [NSFileHandle fileHandleWithNullDevice];
	task.standardError = [NSFileHandle fileHandleWithNullDevice];
	if ([task launchAndReturnError:NULL]) [task waitUntilExit];
}

// ------------------------------------------------------------- the other half

/* The Node process behind the window, and the requests to its control API. */
@interface Backend : NSObject
@property(copy) NSString *root;
/** The process, when this program started it; nil when it was found running. */
@property(strong) NSTask *task;
/** Port of the control API on 127.0.0.1; 0 while there is none. */
@property NSInteger port;
@property(strong) NSURLSession *session;
- (instancetype)initWithRoot:(NSString *)root;
- (NSURL *)urlFor:(NSString *)path;
- (NSInteger)request:(NSString *)method path:(NSString *)path json:(NSString *)json timeout:(NSTimeInterval)timeout;
- (BOOL)attach;
- (BOOL)start:(NSString **)error;
@end

@implementation Backend

- (instancetype)initWithRoot:(NSString *)root {
	if ((self = [super init])) {
		_root = [root copy];
		NSURLSessionConfiguration *config = [NSURLSessionConfiguration ephemeralSessionConfiguration];
		// The control API is on this machine: no proxy has any business with it.
		config.connectionProxyDictionary = @{};
		config.requestCachePolicy = NSURLRequestReloadIgnoringLocalCacheData;
		_session = [NSURLSession sessionWithConfiguration:config];
	}
	return self;
}

- (NSURL *)urlFor:(NSString *)path {
	return [NSURL URLWithString:[NSString stringWithFormat:@"http://127.0.0.1:%ld%@", (long)self.port, path]];
}

/*
 * One request to the control API, waited for. Returns the HTTP status, or 0
 * when the process did not answer. `json` is the body, or nil.
 */
- (NSInteger)request:(NSString *)method path:(NSString *)path json:(NSString *)json timeout:(NSTimeInterval)timeout {
	if (self.port <= 0) return 0;
	NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:[self urlFor:path]];
	request.HTTPMethod = method;
	request.timeoutInterval = timeout;
	if (json) {
		request.HTTPBody = [json dataUsingEncoding:NSUTF8StringEncoding];
		[request setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];
	}
	__block NSInteger status = 0;
	dispatch_semaphore_t done = dispatch_semaphore_create(0);
	NSURLSessionDataTask *task =
		[self.session dataTaskWithRequest:request
		                completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
			                if ([response isKindOfClass:[NSHTTPURLResponse class]]) {
				                status = ((NSHTTPURLResponse *)response).statusCode;
			                }
			                dispatch_semaphore_signal(done);
		                }];
	[task resume];
	dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, (int64_t)((timeout + 1.0) * NSEC_PER_SEC)));
	return status;
}

/* The note a running launcher keeps: `{"pid":…,"port":…}`. */
- (NSDictionary *)note {
	NSString *file = [self.root stringByAppendingPathComponent:@"launcher/launcher-runtime.json"];
	NSData *data = [NSData dataWithContentsOfFile:file];
	if (!data) return nil;
	id json = [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL];
	return [json isKindOfClass:[NSDictionary class]] ? json : nil;
}

static NSInteger NumberIn(NSDictionary *note, NSString *key) {
	id value = note[key];
	return [value isKindOfClass:[NSNumber class]] ? [value integerValue] : 0;
}

/*
 * Looks for a launcher that is already running — one whose window was closed
 * while the server was on — and connects to it. The note alone proves
 * nothing, so the launcher is asked for its state before it is believed.
 */
- (BOOL)attach {
	NSInteger port = NumberIn([self note], @"port");
	if (port <= 0 || port > 65535) return NO;
	self.port = port;
	if ([self request:@"GET" path:@"/api/state" json:nil timeout:2] == 200) return YES;
	self.port = 0;
	return NO;
}

/*
 * Starts `node launcher/index.mjs --app app --no-open --background` and waits
 * until it has written its note and answers.
 *
 * The process is not tied to this program's life: it ends when it is told to
 * (POST /api/quit), or by itself once it has neither a server nor a window.
 */
- (BOOL)start:(NSString **)error {
	NSString *node = [self.root stringByAppendingPathComponent:@"node/node"];
	NSString *script = [self.root stringByAppendingPathComponent:@"launcher/index.mjs"];
	NSString *app = [self.root stringByAppendingPathComponent:@"app"];

	NSTask *task = [NSTask new];
	task.executableURL = [NSURL fileURLWithPath:node];
	task.arguments = @[ script, @"--app", app, @"--no-open", @"--background" ];
	task.currentDirectoryURL = [NSURL fileURLWithPath:self.root isDirectory:YES];
	task.standardInput = [NSFileHandle fileHandleWithNullDevice];
	task.standardOutput = [NSFileHandle fileHandleWithNullDevice];
	task.standardError = [NSFileHandle fileHandleWithNullDevice];

	NSError *failure = nil;
	if (![task launchAndReturnError:&failure]) {
		if (error) {
			*error = [NSString stringWithFormat:T(@"Не удалось запустить Node.js:\n\n%@\n\n%@",
			                                     @"Node.js could not be started:\n\n%@\n\n%@"),
			                                   node, failure.localizedDescription ?: @""];
		}
		return NO;
	}
	self.task = task;

	NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:30];
	while (deadline.timeIntervalSinceNow > 0 && task.isRunning) {
		NSDictionary *note = [self note];
		NSInteger port = NumberIn(note, @"port");
		if (NumberIn(note, @"pid") == task.processIdentifier && port > 0 && port < 65536) {
			self.port = port;
			if ([self request:@"GET" path:@"/api/state" json:nil timeout:2] == 200) return YES;
		}
		[NSThread sleepForTimeInterval:0.1];
	}
	self.port = 0;
	if (error) {
		*error = T(@"Служебный процесс notGT не запустился.\n\n"
		           @"Проверьте, что ZIP-архив распакован целиком, и запустите программу снова.",
		           @"notGT's service process did not start.\n\n"
		           @"Check that the ZIP archive was unpacked completely, and start the program again.");
	}
	return NO;
}

@end

// ------------------------------------------------------------------ the window

@interface AppDelegate : NSObject <NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate>
@property(strong) NSWindow *window;
@property(strong) WKWebView *webView;
@property(strong) Backend *backend;
@property(strong) NSTimer *pulse;
@property(copy) NSString *rootOverride;
@property(copy) NSString *snapshotPath;
@property BOOL snapshotStarted;
/** How many times in a row the launcher did not answer. */
@property NSInteger misses;
@property BOOL recovering;
@property NSInteger loadRetries;
@end

@implementation AppDelegate

/* Says what went wrong and ends the program. */
- (void)fail:(NSString *)message code:(int)code {
	if (gUnattended) {
		fprintf(stderr, "notGT Launcher: %s\n", message.UTF8String);
		exit(code);
	}
	NSAlert *alert = [NSAlert new];
	alert.alertStyle = NSAlertStyleCritical;
	alert.messageText = @"notGT Launcher";
	alert.informativeText = message;
	[alert addButtonWithTitle:T(@"Закрыть", @"Close")];
	[alert runModal];
	exit(code);
}

- (void)buildMenu {
	NSString *name = @"notGT Launcher";
	NSMenu *bar = [NSMenu new];

	NSMenuItem *appItem = [bar addItemWithTitle:@"" action:NULL keyEquivalent:@""];
	NSMenu *appMenu = [[NSMenu alloc] initWithTitle:name];
	[appMenu addItemWithTitle:[T(@"Скрыть ", @"Hide ") stringByAppendingString:name]
	                   action:@selector(hide:)
	            keyEquivalent:@"h"];
	[appMenu addItem:[NSMenuItem separatorItem]];
	[appMenu addItemWithTitle:[T(@"Завершить ", @"Quit ") stringByAppendingString:name]
	                   action:@selector(terminate:)
	            keyEquivalent:@"q"];
	appItem.submenu = appMenu;

	// Without an Edit menu the usual shortcuts do nothing in the page's fields.
	NSMenuItem *editItem = [bar addItemWithTitle:@"" action:NULL keyEquivalent:@""];
	NSMenu *edit = [[NSMenu alloc] initWithTitle:T(@"Правка", @"Edit")];
	[edit addItemWithTitle:T(@"Отменить", @"Undo") action:NSSelectorFromString(@"undo:") keyEquivalent:@"z"];
	[edit addItemWithTitle:T(@"Повторить", @"Redo") action:NSSelectorFromString(@"redo:") keyEquivalent:@"Z"];
	[edit addItem:[NSMenuItem separatorItem]];
	[edit addItemWithTitle:T(@"Вырезать", @"Cut") action:@selector(cut:) keyEquivalent:@"x"];
	[edit addItemWithTitle:T(@"Скопировать", @"Copy") action:@selector(copy:) keyEquivalent:@"c"];
	[edit addItemWithTitle:T(@"Вставить", @"Paste") action:@selector(paste:) keyEquivalent:@"v"];
	[edit addItemWithTitle:T(@"Выбрать всё", @"Select All") action:@selector(selectAll:) keyEquivalent:@"a"];
	editItem.submenu = edit;

	NSMenuItem *windowItem = [bar addItemWithTitle:@"" action:NULL keyEquivalent:@""];
	NSMenu *windowMenu = [[NSMenu alloc] initWithTitle:T(@"Окно", @"Window")];
	[windowMenu addItemWithTitle:T(@"Свернуть", @"Minimize") action:@selector(performMiniaturize:) keyEquivalent:@"m"];
	[windowMenu addItemWithTitle:T(@"Закрыть", @"Close") action:@selector(performClose:) keyEquivalent:@"w"];
	windowItem.submenu = windowMenu;

	NSApp.mainMenu = bar;
	NSApp.windowsMenu = windowMenu;
}

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
	NSArray<NSString *> *arguments = NSProcessInfo.processInfo.arguments;
	for (NSUInteger i = 1; i + 1 < arguments.count; i++) {
		if ([arguments[i] isEqualToString:@"--root"]) self.rootOverride = arguments[i + 1];
		if ([arguments[i] isEqualToString:@"--snapshot"]) self.snapshotPath = arguments[i + 1];
	}
	gUnattended = self.snapshotPath != nil;
	gRussian = [NSLocale.preferredLanguages.firstObject hasPrefix:@"ru"];

	[self buildMenu];

	NSString *root = self.rootOverride ?: [OriginalBundlePath() stringByDeletingLastPathComponent];
	root = root.stringByStandardizingPath;
	NSFileManager *files = NSFileManager.defaultManager;
	BOOL whole = [files isExecutableFileAtPath:[root stringByAppendingPathComponent:@"node/node"]] &&
		[files fileExistsAtPath:[root stringByAppendingPathComponent:@"launcher/index.mjs"]] &&
		[files fileExistsAtPath:[root stringByAppendingPathComponent:@"app/index.js"]];
	if (!whole) {
		[self fail:[NSString stringWithFormat:
			                     T(@"Рядом с программой нет папок node, launcher и app.\n\n"
			                       @"Распакуйте ZIP-архив целиком и запускайте программу из распакованной "
			                       @"папки, не вынимая её оттуда.\n\n"
			                       @"Если папки на месте, macOS запустила программу из карантина. "
			                       @"Выполните в Терминале и запустите её снова:\n\n"
			                       @"xattr -dr com.apple.quarantine \"%@\"",
			                       @"The folders node, launcher and app are not next to the program.\n\n"
			                       @"Unpack the whole ZIP archive and start the program from the unpacked "
			                       @"folder, without taking it out of there.\n\n"
			                       @"If the folders are in place, macOS started the program from quarantine. "
			                       @"Run this in Terminal and start it again:\n\n"
			                       @"xattr -dr com.apple.quarantine \"%@\""),
			                     root]
		      code:2];
	}

	RemoveQuarantine(root);

	self.backend = [[Backend alloc] initWithRoot:root];
	NSString *problem = nil;
	if (![self.backend attach] && ![self.backend start:&problem]) {
		[self fail:problem ?: T(@"Служебный процесс notGT не запустился.", @"notGT's service process did not start.")
		      code:2];
	}

	NSRect frame = NSMakeRect(0, 0, 780, 860);
	self.window = [[NSWindow alloc] initWithContentRect:frame
	                                          styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
	                                                    NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable
	                                            backing:NSBackingStoreBuffered
	                                              defer:NO];
	self.window.title = @"notGT Launcher";
	self.window.minSize = NSMakeSize(520, 480);
	self.window.releasedWhenClosed = NO;
	[self.window center];
	[self.window setFrameAutosaveName:@"notGT Launcher"];

	self.webView = [[WKWebView alloc] initWithFrame:frame configuration:[WKWebViewConfiguration new]];
	self.webView.navigationDelegate = self;
	self.webView.UIDelegate = self;
	self.webView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
	self.window.contentView = self.webView;

	[self loadPage];
	[self.window makeKeyAndOrderFront:nil];
	[NSApp activateIgnoringOtherApps:YES];

	// The page asks for the state every second, and that is what tells the
	// launcher a window is still there. A page in a hidden window is slowed
	// down by the system, so the window asks as well.
	self.pulse = [NSTimer scheduledTimerWithTimeInterval:5 target:self selector:@selector(checkPulse) userInfo:nil repeats:YES];

	if (gUnattended) {
		// The build's check must end by itself whatever happens.
		dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(60 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
			fprintf(stderr, "notGT Launcher: the page was not shown within 60 s\n");
			[self.backend request:@"POST" path:@"/api/quit" json:@"{\"stop\":true}" timeout:2];
			exit(4);
		});
	}
}

- (void)loadPage {
	[self.webView loadRequest:[NSURLRequest requestWithURL:[self.backend urlFor:@"/"]]];
}

/*
 * Asks the launcher whether it is still there. When it is gone — it ends by
 * itself after 20 s with no server and nobody asking — it is found or started
 * again and the page is loaded anew.
 */
- (void)checkPulse {
	if (self.recovering) return;
	Backend *backend = self.backend;
	dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
		NSInteger status = [backend request:@"GET" path:@"/api/state" json:nil timeout:3];
		dispatch_async(dispatch_get_main_queue(), ^{
			if (status == 200) {
				self.misses = 0;
				return;
			}
			self.misses += 1;
			if (self.misses < 3 || self.recovering) return;
			self.recovering = YES;
			dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
				BOOL back = [backend attach] || [backend start:NULL];
				dispatch_async(dispatch_get_main_queue(), ^{
					self.recovering = NO;
					self.misses = 0;
					if (back) [self loadPage];
				});
			});
		});
	});
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender {
	return YES;
}

- (BOOL)applicationSupportsSecureRestorableState:(NSApplication *)app {
	return YES;
}

/* The window is closing: a server that is running stays up, and its launcher with it. */
- (void)applicationWillTerminate:(NSNotification *)notification {
	[self.pulse invalidate];
	[self.backend request:@"POST" path:@"/api/quit" json:@"{\"stop\":false}" timeout:2];
}

// ---------------------------------------------------------------- the page

/* The page is the launcher's own; every other address belongs in the browser. */
- (void)webView:(WKWebView *)webView
	decidePolicyForNavigationAction:(WKNavigationAction *)action
	                decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
	NSURL *url = action.request.URL;
	BOOL ours = [url.host isEqualToString:@"127.0.0.1"] && url.port.integerValue == self.backend.port;
	if (ours || [url.scheme isEqualToString:@"about"] || [url.scheme isEqualToString:@"data"] ||
		[url.scheme isEqualToString:@"blob"]) {
		decisionHandler(WKNavigationActionPolicyAllow);
		return;
	}
	if ([url.scheme isEqualToString:@"http"] || [url.scheme isEqualToString:@"https"]) {
		[NSWorkspace.sharedWorkspace openURL:url];
	}
	decisionHandler(WKNavigationActionPolicyCancel);
}

/* A link that asks for a new window opens in the browser. */
- (WKWebView *)webView:(WKWebView *)webView
	createWebViewWithConfiguration:(WKWebViewConfiguration *)configuration
	           forNavigationAction:(WKNavigationAction *)action
	                windowFeatures:(WKWindowFeatures *)features {
	NSURL *url = action.request.URL;
	if ([url.scheme isEqualToString:@"http"] || [url.scheme isEqualToString:@"https"]) {
		[NSWorkspace.sharedWorkspace openURL:url];
	}
	return nil;
}

- (void)webView:(WKWebView *)webView
	runJavaScriptAlertPanelWithMessage:(NSString *)message
	                  initiatedByFrame:(WKFrameInfo *)frame
	                 completionHandler:(void (^)(void))completionHandler {
	NSAlert *alert = [NSAlert new];
	alert.messageText = message ?: @"";
	[alert addButtonWithTitle:@"OK"];
	[alert beginSheetModalForWindow:self.window
	              completionHandler:^(NSModalResponse response) {
		              completionHandler();
	              }];
}

- (void)webView:(WKWebView *)webView
	runJavaScriptConfirmPanelWithMessage:(NSString *)message
	                    initiatedByFrame:(WKFrameInfo *)frame
	                   completionHandler:(void (^)(BOOL))completionHandler {
	NSAlert *alert = [NSAlert new];
	alert.messageText = message ?: @"";
	[alert addButtonWithTitle:@"OK"];
	[alert addButtonWithTitle:T(@"Отмена", @"Cancel")];
	[alert beginSheetModalForWindow:self.window
	              completionHandler:^(NSModalResponse response) {
		              completionHandler(response == NSAlertFirstButtonReturn);
	              }];
}

/* The launcher answered a moment ago, so a page that fails to load is tried again. */
- (void)webView:(WKWebView *)webView
	didFailProvisionalNavigation:(WKNavigation *)navigation
	                   withError:(NSError *)error {
	if (self.loadRetries >= 10) return;
	self.loadRetries += 1;
	dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.5 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
		[self loadPage];
	});
}

- (void)webViewWebContentProcessDidTerminate:(WKWebView *)webView {
	[self loadPage];
}

- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
	self.loadRetries = 0;
	if (!self.snapshotPath || self.snapshotStarted) return;
	self.snapshotStarted = YES;
	// Long enough for the page to have asked for the state and drawn it.
	dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(2.5 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
		[self takeSnapshot];
	});
}

/* The build's check: is the launcher's page really in the window? */
- (void)takeSnapshot {
	[self.webView evaluateJavaScript:@"document.body ? document.body.innerText.length : 0"
	               completionHandler:^(id result, NSError *error) {
		               NSInteger length = [result isKindOfClass:[NSNumber class]] ? [result integerValue] : 0;
		               if (length < 50) {
			               fprintf(stderr, "notGT Launcher: the page is empty (%ld characters)\n", (long)length);
			               [self.backend request:@"POST" path:@"/api/quit" json:@"{\"stop\":true}" timeout:2];
			               exit(5);
		               }
		               [self.webView takeSnapshotWithConfiguration:nil
		                                         completionHandler:^(NSImage *image, NSError *snapshotError) {
			                                         BOOL written = NO;
			                                         NSData *tiff = image.TIFFRepresentation;
			                                         if (tiff) {
				                                         NSBitmapImageRep *rep = [NSBitmapImageRep imageRepWithData:tiff];
				                                         NSData *png = [rep representationUsingType:NSBitmapImageFileTypePNG
				                                                                         properties:@{}];
				                                         written = [png writeToFile:self.snapshotPath atomically:YES];
			                                         }
			                                         fprintf(stderr, "notGT Launcher: page shown, %ld characters; picture %s\n",
			                                                 (long)length, written ? "saved" : "not taken");
			                                         [self.backend request:@"POST"
			                                                          path:@"/api/quit"
			                                                          json:@"{\"stop\":true}"
			                                                       timeout:2];
			                                         exit(written ? 0 : 3);
		                                         }];
	               }];
}

@end

int main(int argc, const char *argv[]) {
	@autoreleasepool {
		NSApplication *application = [NSApplication sharedApplication];
		// The application does not keep its delegate; this does.
		static AppDelegate *delegate;
		delegate = [AppDelegate new];
		application.delegate = delegate;
		[application setActivationPolicy:NSApplicationActivationPolicyRegular];
		[application run];
	}
	return 0;
}
