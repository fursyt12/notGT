import type express from "express";

import { config } from "../config";
import { accessProvider, isKnownLocalUser } from "../server/login/access";

/**
 * Express middleware that checks if the user is authenticated.
 */
export const authCheck: express.RequestHandler = async (req, res, next) => {
	try {
		if (!config.login?.enabled) {
			next();
			return;
		}

		let { user } = req;
		let isUsingKeyOrSocketToken = false;
		let keyOrSocketTokenAuthenticated = false;
		let presented: unknown = req.query.key ?? req.cookies.socketToken;

		// notGT: a key of a graphic rather than of a user. It opens what its
		// grant names and nothing else — least of all the dashboard.
		const grant =
			typeof presented === "string"
				? accessProvider()?.findKey(presented)
				: undefined;
		if (grant) {
			const { pathname } = new URL(req.originalUrl, "http://localhost");
			if (grant.allows({ path: pathname, query: req.query })) {
				// The files the page asks for next carry no key: a browser with
				// no session (OBS) presents this one as a cookie instead.
				if (!req.isAuthenticated()) {
					res.cookie("socketToken", presented, {
						secure: req.secure,
						sameSite: req.secure ? "none" : undefined,
					});
				}

				next();
				return;
			}

			if (req.query.key !== undefined) {
				res.status(403).send("This key does not open this page");
				return;
			}

			// Only the cookie left behind by a graphic: the browser may still
			// belong to an operator with a session of their own.
			presented = undefined;
		}

		if (presented) {
			isUsingKeyOrSocketToken = true;
			const apiKey =
				typeof presented === "string"
					? await res.locals.databaseAdapter.findApiKey(presented)
					: null;

			// No record of this API Key found, reject the request.
			if (!apiKey) {
				// Ensure we delete the existing cookie so that it doesn't become poisoned
				// and cause an infinite login loop.
				req.session?.destroy(() => {
					res.clearCookie("socketToken", {
						secure: req.secure,
						sameSite: req.secure ? "none" : undefined,
					});
					res.clearCookie("connect.sid", { path: "/" });
					res.clearCookie("io", { path: "/" });

					res.redirect("/login");
				});
				return;
			}

			user =
				(await res.locals.databaseAdapter.findUser(apiKey.user.id)) ??
				undefined;
		}

		if (!user) {
			if (req.session) {
				req.session.returnTo = req.url;
			}

			res.status(403).redirect("/login");
			return;
		}

		const allowed = res.locals.databaseAdapter.isSuperUser(user);
		keyOrSocketTokenAuthenticated = isUsingKeyOrSocketToken && allowed;
		const provider = user.identities[0]!.provider_type;
		const providerAllowed = config.login?.[provider]?.enabled;
		// notGT: a local user who was taken off the team is not let in by the
		// key or the session they still hold.
		const known = provider !== "local" || isKnownLocalUser(user.name);
		if (
			(keyOrSocketTokenAuthenticated || req.isAuthenticated()) &&
			allowed &&
			providerAllowed &&
			known
		) {
			// A request let in by a key has no session; whoever handles it next
			// still needs to know whose it is.
			req.user ??= user;

			let apiKey = user.apiKeys[0];

			// This should only happen if the database is manually edited, say, in the event of a security breach
			// that reavealed an API key that needed to be deleted.
			if (!apiKey) {
				// Make a new api key.
				apiKey = await res.locals.databaseAdapter.createApiKey();

				// Assign this key to the user.
				user.apiKeys.push(apiKey);
				await res.locals.databaseAdapter.saveUser(user);
			}

			// Set the cookie so that requests to other resources on the page
			// can also be authenticated.
			// This is crucial for things like OBS browser sources,
			// where we don't have a session.
			res.cookie("socketToken", apiKey.secret_key, {
				secure: req.secure,
				sameSite: req.secure ? "none" : undefined,
			});

			next();
			return;
		}

		if (req.session) {
			req.session.returnTo = req.url;
		}

		res.status(403).redirect("/login");
		return;
	} catch (error: unknown) {
		next(error);
	}
};
