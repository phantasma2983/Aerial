const fs = require("fs");
const path = require("path");
const {spawnSync} = require("child_process");

const configPath = path.join(__dirname, "lint-targets.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const targets = Array.isArray(config.targets) ? config.targets : [];

if (process.argv.includes("--list")) {
    for (const target of targets) {
        console.log(target);
    }
    process.exit(0);
}

if (targets.length === 0) {
    console.error("No lint targets configured in scripts/lint-targets.json");
    process.exit(1);
}

let hasError = false;
for (const target of targets) {
    const fullPath = path.resolve(process.cwd(), target);
    if (!fs.existsSync(fullPath)) {
        console.error(`Missing lint target: ${target}`);
        hasError = true;
        continue;
    }
    const result = spawnSync(process.execPath, ["--check", fullPath], {stdio: "inherit"});
    if (result.status !== 0) {
        hasError = true;
    }
}

if (hasError) {
    process.exit(1);
}
