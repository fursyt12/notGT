import { config } from "../../config";

/**
 * notGT: who may come in, beyond what `nodecg.json` says.
 *
 * NodeCG knows one kind of local user — the ones listed in its config, all of
 * them equal — and one kind of key, a user's own. A bundle that keeps a team
 * (users made by an administrator, keys that open a single graphic) registers
 * a provider here, and the login, the session check and the socket check ask
 * it.
 */
export interface AccessProvider {
	/** Signs in a local user the config does not list. */
	verifyUser: (username: string, password: string) => boolean;
	/** Whether a local user who signed in earlier still exists. */
	hasUser: (username: string) => boolean;
	/**
	 * A key that is not a user's own: what it may fetch, or `undefined` when
	 * the key is not one of the provider's. A socket opened with such a key
	 * only reads.
	 */
	findKey: (key: string) => KeyGrant | undefined;
	/**
	 * The account a new installation starts with, for as long as its password
	 * is the one everybody knows. The sign-in page shows it: someone has to
	 * get in the first time, and a password this well known is no secret.
	 */
	defaultSignIn?: () => { username: string; password: string } | undefined;
}

export interface KeyGrant {
	allows: (request: {
		path: string;
		query: Record<string, unknown>;
	}) => boolean;
	/**
	 * Whether the key's socket may send this message to a bundle: what a
	 * page that only reads still has to ask, such as the server's clock.
	 */
	sends?: (request: { bundleName: string; messageName: string }) => boolean;
}

let provider: AccessProvider | undefined;

export const setAccessProvider = (next: AccessProvider | undefined): void => {
	provider = next;
};

export const accessProvider = (): AccessProvider | undefined => provider;

/**
 * A local user has to exist for as long as their session or their key is
 * used: taking someone off the team takes their access with it.
 */
export const isKnownLocalUser = (username: string): boolean => {
	const listed =
		config.login.enabled &&
		config.login.local?.allowedUsers?.some(
			(user) => user.username === username,
		);
	return Boolean(listed) || Boolean(provider?.hasUser(username));
};

/** What a socket that only reads may send. */
export const READ_ONLY_EVENTS: ReadonlySet<string> = new Set([
	"replicant:declare",
	"replicant:read",
	"joinRoom",
	"graphic:registerSocket",
	"graphic:queryAvailability",
]);
