import {defineConfig} from "vite";
import preact from "@preact/preset-vite";
import path from "node:path";

export default defineConfig({
    plugins: [preact()],
    build: {
        outDir: "web/generated",
        emptyOutDir: true,
        sourcemap: true,
        rollupOptions: {
            input: {
                widgetConfig: path.resolve("src/renderer/config/widget-app.tsx"),
                widgetHost: path.resolve("src/renderer/widgets/widget-host.tsx")
            },
            output: {
                entryFileNames: "[name].js",
                chunkFileNames: "chunks/[name]-[hash].js",
                assetFileNames: "assets/[name]-[hash][extname]"
            }
        }
    }
});
