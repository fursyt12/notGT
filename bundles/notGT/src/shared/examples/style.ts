/**
 * The look the built-in examples share, so the library reads as one graphics
 * package — the notGT brand (media/brand): Studio green plates, Cream type, one
 * Signal pink accent, Lemon for LIVE, and a slanted cut on the trailing edge of
 * every plate. Montserrat sets the text; Handjet sets numerals and headlines.
 *
 * Plates are inline SVG images. A shape layer is a plain rectangle; an SVG can
 * carry the slanted edge and the gradient, needs no uploaded file, and is drawn
 * the same on the Editor canvas and on the out page.
 */
export const STUDIO = "#0c2b25";
export const STUDIO_LIGHT = "#123630";
export const CREAM = "#f5ecda";
export const SIGNAL = "#ff5a8c";
export const AMBER = "#ff8a3c";
export const LEMON = "#ffd23f";
export const SAGE = "#a9b8a8";

/** Both fonts ship with the bundle (`graphics/fonts`). */
export const FONT = "Montserrat, 'Segoe UI', Roboto, Arial, sans-serif";
export const DISPLAY = "Handjet, Montserrat, sans-serif";

/** Gradients every plate may use: `url(#studio)`, `url(#signal)`, `url(#cream)`. */
const DEFS =
	"<defs>" +
	`<linearGradient id='studio' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='${STUDIO_LIGHT}'/><stop offset='1' stop-color='#0a251f'/></linearGradient>` +
	`<linearGradient id='signal' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='#ff6c98'/><stop offset='1' stop-color='${SIGNAL}'/></linearGradient>` +
	`<linearGradient id='cream' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='#fbf6ea'/><stop offset='1' stop-color='${CREAM}'/></linearGradient>` +
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
export function lowerThirdPlate(variant: "studio" | "cream"): string {
	const plate = variant === "studio" ? "url(#studio)" : "url(#cream)";
	const tab = variant === "studio" ? "url(#signal)" : STUDIO;
	return svgImage(
		1040,
		184,
		`<polygon points='0,0 1040,0 1002,124 0,124' fill='${plate}' fill-opacity='.97'/>` +
			"<polygon points='0,0 1040,0 1039,3 0,3' fill='#ffffff' fill-opacity='.10'/>" +
			"<rect width='10' height='124' fill='url(#signal)'/>" +
			`<polygon points='0,124 650,124 632,184 0,184' fill='${tab}'/>`,
	);
}

/** The notGT mark, 128×128, for an example that needs a logo to stand in. */
export const MARK =
	"<mask id='strike' maskUnits='userSpaceOnUse' x='0' y='0' width='128' height='128'><rect width='128' height='128' fill='#fff'/><rect x='10' y='47.5' width='108' height='19' fill='#000'/></mask>" +
	`<rect width='128' height='128' rx='26' fill='${CREAM}'/>` +
	`<path d='M30.35,101.5L54.51,101.5L54.51,95.15L60.86,95.15L60.86,64.64L36.71,64.64L36.71,76.08L49.42,76.08L49.42,90.06L35.44,90.06L35.44,37.94L49.42,37.94L49.42,57.01L60.86,57.01L60.86,32.86L54.51,32.86L54.51,26.5L30.35,26.5L30.35,32.86L24,32.86L24,95.15L30.35,95.15ZM79.85,101.5L91.29,101.5L91.29,37.94L104,37.94L104,26.5L67.14,26.5L67.14,37.94L79.85,37.94Z' fill='${STUDIO}' mask='url(#strike)'/>` +
	`<rect x='14' y='52.5' width='100' height='9' fill='${SIGNAL}'/>`;
