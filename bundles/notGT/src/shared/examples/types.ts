/**
 * Description of one built-in example animation: a ready to use `kind: "code"`
 * template, shipped inside the bundle like `Code sample (ticker)`.
 */
export interface ExampleCode {
	/** Template id. Stable: the one-time migration looks templates up by it. */
	id: string;
	/** Human readable name shown in the dashboard. */
	name: string;
	/** Body markup of the animation. */
	html: string;
	/** Stylesheet of the animation. */
	css: string;
	/** Script of the animation; runs after the notGT runtime is injected. */
	js: string;
	/** How long the animation's own exit takes, ms (see `onHide`). */
	exitMs?: number;
}
