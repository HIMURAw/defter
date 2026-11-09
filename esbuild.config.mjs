import esbuild from "esbuild";
import { builtinModules } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";

const production = process.argv[2] === "production";

// styles.css = embedded fonts + src/styles.css. Fonts are inlined because an
// Obsidian plugin ships exactly three files.
function buildCss() {
  const LATIN = "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";
  const LATIN_EXT = "U+0100-0130,U+0132-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF";
  const face = (family, weight, file, range) => {
    const data = readFileSync(`fonts/${file}`).toString("base64");
    return `@font-face{font-family:"${family}";font-weight:${weight};font-display:block;src:url(data:font/woff2;base64,${data}) format("woff2");unicode-range:${range};}\n`;
  };
  const fonts = [
    ["Defter Caveat", 500, "caveat", 500],
    ["Defter Kalam", 400, "kalam", 400],
    ["Defter Patrick", 400, "patrick-hand", 400],
    ["Defter Shantell", 400, "shantell-sans", 400],
  ]
    .map(([family, weight, file, w]) => face(family, weight, `${file}-latin-${w}.woff2`, LATIN) + face(family, weight, `${file}-latin-ext-${w}.woff2`, LATIN_EXT))
    .join("");
  writeFileSync(
    "styles.css",
    "/* Handwriting fonts (Caveat, Kalam, Patrick Hand, Shantell Sans): SIL Open Font License 1.1, see fonts/OFL-*.txt */\n" +
      fonts +
      readFileSync("src/styles.css", "utf8")
  );
}

const cssPlugin = {
  name: "defter-css",
  setup(build) {
    build.onEnd(() => buildCss());
  },
};

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtinModules],
  format: "cjs",
  target: "es2022",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: production,
  plugins: [cssPlugin],
});

if (production) {
  await ctx.rebuild();
  await ctx.dispose();
} else {
  await ctx.watch();
}
