import type { Metadata } from "next";
import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import "./globals.css";

export const metadata: Metadata = {
  title: "Hurdle — Together Agent Evals",
  description: "Inspect canonical Run Records from an agent evaluation Result Store",
  icons: {
    icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90' font-weight='bold' font-family='system-ui'>h</text></svg>",
  },
};

// Resolve the saved preference before the first paint. With no saved choice,
// the Viewer follows the operating system and keeps following it at runtime.
const THEME_SCRIPT = `
(function(){
  try {
    var preference = window.matchMedia('(prefers-color-scheme: dark)');
    var transitionFrame = null;
    var cleanupFrame = null;
    function apply(){
      var root = document.documentElement;
      if (transitionFrame !== null) window.cancelAnimationFrame(transitionFrame);
      if (cleanupFrame !== null) window.cancelAnimationFrame(cleanupFrame);
      root.classList.add('theme-changing');
      void root.offsetHeight;
      var stored = localStorage.getItem('tae-theme');
      var choice = stored === 'light' || stored === 'dark' || stored === 'system'
        ? stored
        : 'system';
      var dark = choice === 'dark' || (choice === 'system' && preference.matches);
      root.classList.toggle('dark', dark);
      root.style.colorScheme = dark ? 'dark' : 'light';
      transitionFrame = window.requestAnimationFrame(function(){
        cleanupFrame = window.requestAnimationFrame(function(){
          root.classList.remove('theme-changing');
          transitionFrame = null;
          cleanupFrame = null;
        });
      });
    }
    apply();
    preference.addEventListener('change', apply);
  } catch (_) {}
})();
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${GeistSans.variable} ${GeistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="h-full overflow-hidden flex flex-col">
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        {children}
      </body>
    </html>
  );
}
