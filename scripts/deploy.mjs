// Copies the build into a vault's plugin folder.
// Target: DEFTER_VAULT env var, default is the author's vault.
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const vault = process.env.DEFTER_VAULT || join(homedir(), "Masaüstü", "Brain");
const target = join(vault, ".obsidian", "plugins", "defter");
mkdirSync(target, { recursive: true });
for (const f of ["main.js", "manifest.json", "styles.css"]) copyFileSync(f, join(target, f));
console.log("deployed to " + target);
