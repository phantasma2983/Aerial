const fs = require("fs");
const path = require("path");

const distDir = path.resolve(__dirname, "..", "dist");
const portableExe = path.join(distDir, "aerial.exe");
const screensaverArtifact = path.join(distDir, "Aerial.scr");
const RETRYABLE_ERRORS = new Set(["EBUSY", "EPERM"]);
const MAX_ATTEMPTS = 20;
const RETRY_DELAY_MS = 300;

if (!fs.existsSync(portableExe)) {
    console.error(`Portable artifact not found: ${portableExe}`);
    console.error("Run a build that includes the portable target before creating the .scr artifact.");
    process.exit(1);
}

async function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function copyWithRetry(source, destination) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            await fs.promises.copyFile(source, destination);
            return;
        } catch (error) {
            const canRetry = RETRYABLE_ERRORS.has(error?.code) && attempt < MAX_ATTEMPTS;
            if (!canRetry) {
                throw error;
            }
            await delay(RETRY_DELAY_MS);
        }
    }
}

copyWithRetry(portableExe, screensaverArtifact)
    .then(() => {
        console.log(`Created screensaver artifact: ${screensaverArtifact}`);
    })
    .catch((error) => {
        console.error(`Failed to create screensaver artifact: ${error.message}`);
        process.exit(1);
    });
