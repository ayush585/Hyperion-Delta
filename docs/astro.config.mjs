import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://ayush585.github.io",
  base: "/Hyperion-Delta/",
  customCss: ["./src/styles/custom.css"],
  integrations: [
    starlight({
      title: "Hyperion Delta",
      description:
        "Zero-config local agent state management for dirty-set-scale rollback.",
      social: {
        github: "https://github.com/ayush585/Hyperion-Delta",
      },
      sidebar: [
        { label: "Home", link: "/" },
        {
          label: "Getting Started",
          items: [
            { label: "Quickstart", link: "/guides/getting-started/" },
            { label: "Core Concepts", link: "/guides/concepts/" },
          ],
        },
        {
          label: "Architecture",
          items: [
            { label: "Thesis", link: "/architecture/thesis/" },
            { label: "Strategy Tiers", link: "/architecture/strategies/" },
            { label: "Safety Model", link: "/architecture/safety/" },
            { label: "Git Companion", link: "/architecture/git-companion/" },
          ],
        },
        {
          label: "API Reference",
          items: [
            { label: "HyperionWorkspace", link: "/api/workspace/" },
            { label: "Agent Session", link: "/api/agent-session/" },
            { label: "Types & Errors", link: "/api/types/" },
          ],
        },
        {
          label: "Guides",
          items: [
            { label: "Limitations", link: "/guides/limitations/" },
            { label: "Security", link: "/guides/security/" },
            { label: "Troubleshooting", link: "/guides/troubleshooting/" },
            { label: "Release", link: "/guides/release/" },
          ],
        },
        {
          label: "Benchmark",
          items: [
            { label: "Results", link: "/benchmark/results/" },
            { label: "Reproduce", link: "/benchmark/reproduce/" },
          ],
        },
      ],
    }),
  ],
});