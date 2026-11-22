"use client";

import {ThemeProvider as NextThemesProvider} from "next-themes";

// next-themes renders an inline script so the theme is applied before paint.
// React 19 reports that script when the provider renders on the client. The
// script still runs from the server HTML; this hides that false positive.
if (typeof window !== "undefined" && process.env.NODE_ENV === "development") {
    const originalConsoleError = console.error.bind(console);
    console.error = (...args: unknown[]) => {
        if (typeof args[0] === "string" && args[0].includes("Encountered a script tag")) {
            return;
        }
        originalConsoleError(...args);
    };
}

export function ThemeProvider({children}: {children: React.ReactNode}) {
    return (
        <NextThemesProvider
            attribute="class"
            defaultTheme="system"
            enableSystem
            disableTransitionOnChange
        >
            {children}
        </NextThemesProvider>
    );
}
