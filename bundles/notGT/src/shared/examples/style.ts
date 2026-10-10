/**
 * The look the built-in examples share, so the library reads as one graphics
 * package: ink plates, a single signal red, white type, and a slanted cut on
 * the trailing edge of every plate.
 *
 * Plates are inline SVG images. A shape layer is a plain rectangle; an SVG can
 * carry the slanted edge and the gradient, needs no uploaded file, and is drawn
 * the same on the Editor canvas and on the out page.
 */
export const INK = "#0a0e14";
export const INK_LIGHT = "#18212d";
export const RED = "#ff3b30";
export const RED_DEEP = "#dc2a20";
export const MIST = "#aab6c4";

export const FONT = "Inter, 'Segoe UI', Roboto, Arial, sans-serif";

/** Gradients every plate may use: `url(#ink)`, `url(#red)`, `url(#paper)`. */
const DEFS =
	"<defs>" +
	`<linearGradient id='ink' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='${INK_LIGHT}'/><stop offset='1' stop-color='${INK}'/></linearGradient>` +
	`<linearGradient id='red' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='#ff5245'/><stop offset='1' stop-color='${RED_DEEP}'/></linearGradient>` +
	"<linearGradient id='paper' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#ffffff'/><stop offset='1' stop-color='#e9eef4'/></linearGradient>" +
	"</defs>";

/** An SVG of `width`×`height` px as an image source. */
export function svgImage(width: number, height: number, body: string): string {
	return (
		"data:image/svg+xml," +
		encodeURIComponent(
			`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${width} ${height}'>${DEFS}${body}</svg>`,
		)
	);
}

/**
 * The two-storey plate of a lower third: a wide plate for the name with a
 * slanted trailing edge, and a shorter tab under it for the role.
 */
export function lowerThirdPlate(variant: "ink" | "paper"): string {
	const plate = variant === "ink" ? "url(#ink)" : "url(#paper)";
	const tab = variant === "ink" ? "url(#red)" : INK;
	return svgImage(
		1040,
		184,
		`<polygon points='0,0 1040,0 1002,124 0,124' fill='${plate}' fill-opacity='.97'/>` +
			"<polygon points='0,0 1040,0 1039,3 0,3' fill='#ffffff' fill-opacity='.10'/>" +
			"<rect width='10' height='124' fill='url(#red)'/>" +
			`<polygon points='0,124 650,124 632,184 0,184' fill='${tab}'/>`,
	);
}
