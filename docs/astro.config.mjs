import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://ayush585.github.io",
  base: "/Hyperion-Delta/",
  integrations: [
    starlight({
      title: "Hyperion Delta",
      description:
        "Zero-config local agent state management for dirty-set-scale rollback.",
      social: {
        github: "https://github.com/ayush585/Hyperion-Delta",
      },
      sidebar: [{ label: "Home", link: "/" }],
    }),
  ],
});