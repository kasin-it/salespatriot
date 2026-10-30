import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// MCP Apps are served as one HTML string, so the script and styles are inlined into dist/ui/index.html.
export default defineConfig({
  root: "src/ui",
  plugins: [viteSingleFile()],
  build: { outDir: "../../dist/ui", emptyOutDir: true },
});
