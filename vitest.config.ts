import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        globals: true,
        clearMocks: true,
        hookTimeout: 70_000,
        testTimeout: 600_000,
        include: ["src/**/*.test.ts"],
    },
});
